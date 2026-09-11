import {
	estimateTokens,
	type SessionEntry,
	type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { RuntimeSkill } from "./catalog.ts";
import { DEFAULT_CATALOG_TOKEN_BUDGET } from "./config.ts";
import { immutableMap, immutableSet } from "./immutable.ts";

const MAX_DESCRIBED_SKILLS = 8;
const MAX_QUERY_CHARACTERS = 12_000;
const MAX_RECENT_USER_MESSAGES = 4;
const MAX_RECENT_ASSISTANT_MESSAGES = 2;
const MAX_SUMMARIES = 2;
const MIN_CONFIDENT_SCORE = 4;
const MIN_SIGNAL_SCORE = 0.8;
const NEAR_TIE_RATIO = 0.9;
const MAX_REFERENTIAL_CONTENT_TERMS = 3;
const REFERENTIAL_TERMS = new Set([
	"again",
	"above",
	"continue",
	"earlier",
	"it",
	"next",
	"previous",
	"same",
	"that",
	"these",
	"this",
	"those",
]);
const STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"do",
	"for",
	"from",
	"has",
	"have",
	"how",
	"i",
	"in",
	"is",
	"it",
	"not",
	"of",
	"on",
	"or",
	"that",
	"the",
	"this",
	"to",
	"unless",
	"use",
	"what",
	"when",
	"with",
	"you",
	"your",
]);

export interface RoutingDocument {
	readonly skill: RuntimeSkill;
	readonly normalizedName: string;
	readonly nameTerms: readonly string[];
	readonly termCounts: ReadonlyMap<string, number>;
	readonly bigrams: ReadonlySet<string>;
	readonly characterNgrams: ReadonlySet<string>;
	readonly termCount: number;
}

export interface RoutingIndex {
	readonly documents: readonly RoutingDocument[];
	readonly documentFrequency: ReadonlyMap<string, number>;
	readonly averageDocumentLength: number;
}

export interface RoutingQuery {
	readonly currentPrompt: string;
	readonly exactPrompt: string;
	readonly recentUserText: readonly string[];
	readonly recentAssistantText: readonly string[];
	readonly summaries: readonly string[];
}

export interface RoutingEvidence {
	readonly name: string;
	readonly score: number;
	readonly exactName: boolean;
	readonly nameScore: number;
	readonly phraseScore: number;
	readonly bm25Score: number;
	readonly ngramScore: number;
}

export interface RoutingSelection {
	readonly describedSkills: readonly RuntimeSkill[];
	readonly remainingNames: readonly string[];
	readonly mandatoryNames: readonly string[];
	readonly fallback: boolean;
	readonly reason: string;
	readonly evidence: readonly RoutingEvidence[];
}

export type DisclosureStrategy =
	| "full-catalog"
	| "shortlist"
	| "paginated"
	| "explicit";

export interface AdaptiveDisclosure {
	readonly strategy: DisclosureStrategy;
	readonly reason: string;
	readonly describedSkills: readonly RuntimeSkill[];
	readonly remainingNames: readonly string[];
	readonly incomplete: boolean;
	readonly estimatedTokens: number;
	readonly selection: RoutingSelection;
}

function normalize(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function compareText(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function terms(value: string): string[] {
	return normalize(value).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function countTerms(values: readonly string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
	return counts;
}

function adjacentPairs(values: readonly string[]): Set<string> {
	const result = new Set<string>();
	for (let index = 1; index < values.length; index += 1) {
		result.add(`${values[index - 1]}\u0000${values[index]}`);
	}
	return result;
}

function characterNgrams(value: string): Set<string> {
	const characters = [...normalize(value).replace(/[^\p{L}\p{N}]+/gu, "")];
	const result = new Set<string>();
	if (characters.length < 3) {
		if (characters.length > 0) result.add(characters.join(""));
		return result;
	}
	for (let index = 0; index <= characters.length - 3; index += 1) {
		result.add(characters.slice(index, index + 3).join(""));
	}
	return result;
}

function textFromMessage(message: SessionMessageEntry["message"]): string {
	if (message.role === "user") {
		if (!Array.isArray(message.content)) return message.content;
		return message.content
			.flatMap((block) => (block.type === "text" ? [block.text] : []))
			.join("\n");
	}
	if (message.role === "assistant") {
		return message.content
			.flatMap((block) => (block.type === "text" ? [block.text] : []))
			.join("\n");
	}
	return "";
}

function boundedRecent(values: string[], limit: number): string[] {
	const result: string[] = [];
	let remaining = MAX_QUERY_CHARACTERS;
	for (
		let index = values.length - 1;
		index >= 0 && result.length < limit;
		index -= 1
	) {
		const value = values[index]?.trim();
		if (!value) continue;
		const characters = [...value];
		const bounded = characters
			.slice(Math.max(0, characters.length - remaining))
			.join("");
		if (!bounded) break;
		result.unshift(bounded);
		remaining -= [...bounded].length;
		if (remaining <= 0) break;
	}
	return result;
}

export function buildRoutingQuery(
	currentPrompt: string,
	entries: readonly SessionEntry[] = [],
): RoutingQuery {
	const users: string[] = [];
	const assistants: string[] = [];
	const summaries: string[] = [];

	for (const entry of entries) {
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			summaries.push(entry.summary);
			continue;
		}
		if (entry.type !== "message") continue;
		if (entry.message.role === "toolResult") continue;
		const text = textFromMessage(entry.message);
		if (!text) continue;
		if (entry.message.role === "user") users.push(text);
		if (entry.message.role === "assistant") assistants.push(text);
	}

	const promptCharacters = [...currentPrompt];
	return {
		currentPrompt: promptCharacters
			.slice(Math.max(0, promptCharacters.length - MAX_QUERY_CHARACTERS))
			.join(""),
		exactPrompt: currentPrompt,
		recentUserText: boundedRecent(users, MAX_RECENT_USER_MESSAGES),
		recentAssistantText: boundedRecent(assistants, MAX_RECENT_ASSISTANT_MESSAGES),
		summaries: boundedRecent(summaries, MAX_SUMMARIES),
	};
}

export function buildRoutingIndex(
	skills: readonly RuntimeSkill[],
): RoutingIndex {
	const documents = Object.freeze(
		skills
			.flatMap((skill): RoutingDocument[] => {
				if (skill.disableModelInvocation) return [];
				const descriptionTerms = terms(skill.description);
				const nameTerms = terms(skill.name.replaceAll("-", " "));
				return [
					Object.freeze({
						skill,
						normalizedName: normalize(skill.name),
						nameTerms: Object.freeze(nameTerms),
						termCounts: immutableMap(countTerms(descriptionTerms)),
						bigrams: immutableSet(adjacentPairs(descriptionTerms)),
						characterNgrams: immutableSet(
							characterNgrams(`${skill.name} ${skill.description}`),
						),
						termCount: descriptionTerms.length,
					}),
				];
			})
			.toSorted((left, right) => compareText(left.skill.name, right.skill.name)),
	);

	const documentFrequency = new Map<string, number>();
	let totalTerms = 0;
	for (const document of documents) {
		totalTerms += document.termCount;
		for (const term of document.termCounts.keys()) {
			documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
		}
	}
	return Object.freeze({
		documents,
		documentFrequency: immutableMap(documentFrequency),
		averageDocumentLength:
			documents.length === 0 ? 0 : totalTerms / documents.length,
	});
}

function isReferentialPrompt(prompt: string): boolean {
	const promptTerms = terms(prompt);
	if (!promptTerms.some((term) => REFERENTIAL_TERMS.has(term))) return false;
	const contentTerms = promptTerms.filter(
		(term) => !REFERENTIAL_TERMS.has(term) && !STOP_WORDS.has(term),
	);
	return (
		promptTerms.length <= 16 &&
		contentTerms.length <= MAX_REFERENTIAL_CONTENT_TERMS
	);
}

function querySegments(query: RoutingQuery): string[] {
	const candidates = (
		isReferentialPrompt(query.currentPrompt)
			? [
					...query.summaries,
					...query.recentUserText,
					...query.recentAssistantText,
					query.currentPrompt,
				]
			: [query.currentPrompt]
	).filter((value) => value.trim().length > 0);
	const result: string[] = [];
	let remaining = MAX_QUERY_CHARACTERS;
	for (
		let index = candidates.length - 1;
		index >= 0 && remaining > 0;
		index -= 1
	) {
		const characters = [...(candidates[index] ?? "")];
		const bounded = characters
			.slice(Math.max(0, characters.length - remaining))
			.join("");
		if (bounded.length > 0) result.unshift(bounded);
		remaining -= [...bounded].length;
	}
	return result;
}

function queryText(segments: readonly string[]): string {
	return segments.join("\n");
}

function splitIntents(prompt: string): string[] {
	const pieces = prompt
		.split(/(?:[\n;]+|\.\s+)/u)
		.flatMap((part) => part.split(/\s+(?:while|then|also)\s+/iu));
	const intents = pieces
		.map((part) => part.replace(/\s+/gu, " ").trim())
		.filter((part) => {
			const content = terms(part).filter((term) => !STOP_WORDS.has(term));
			return content.length >= 2;
		});
	return intents.length >= 2 ? intents : [];
}

function intentQuery(intent: string): RoutingQuery {
	return {
		currentPrompt: intent,
		exactPrompt: intent,
		recentUserText: [],
		recentAssistantText: [],
		summaries: [],
	};
}

function containsExactName(
	normalizedQuery: string,
	normalizedName: string,
): boolean {
	if (normalizedName.length === 0) return false;
	let cursor = normalizedQuery.indexOf(normalizedName);
	while (cursor !== -1) {
		const before = cursor === 0 ? "" : (normalizedQuery[cursor - 1] ?? "");
		const after = normalizedQuery[cursor + normalizedName.length] ?? "";
		if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) {
			return true;
		}
		cursor = normalizedQuery.indexOf(normalizedName, cursor + 1);
	}
	return false;
}

function bm25(
	document: RoutingDocument,
	queryTerms: ReadonlyMap<string, number>,
	index: RoutingIndex,
): number {
	if (index.documents.length === 0 || index.averageDocumentLength === 0)
		return 0;
	const k1 = 1.2;
	const b = 0.75;
	let score = 0;
	for (const [term, queryFrequency] of queryTerms) {
		const frequency = document.termCounts.get(term) ?? 0;
		if (frequency === 0) continue;
		const documentFrequency = index.documentFrequency.get(term) ?? 0;
		const inverseDocumentFrequency = Math.log(
			1 +
				(index.documents.length - documentFrequency + 0.5) /
					(documentFrequency + 0.5),
		);
		const denominator =
			frequency +
			k1 * (1 - b + b * (document.termCount / index.averageDocumentLength));
		score +=
			inverseDocumentFrequency *
			((frequency * (k1 + 1)) / denominator) *
			Math.min(queryFrequency, 2);
	}
	return Math.min(score, 12);
}

function overlapScore<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): number {
	if (left.size === 0 || right.size === 0) return 0;
	let intersection = 0;
	for (const value of left) if (right.has(value)) intersection += 1;
	return intersection / Math.max(1, Math.min(left.size, right.size));
}

interface ScoreContext {
	readonly normalizedExactQuery: string;
	readonly queryTerms: ReadonlyMap<string, number>;
	readonly queryBigrams: ReadonlySet<string>;
	readonly queryNgrams: ReadonlySet<string>;
	readonly index: RoutingIndex;
}

function scoreDocument(
	document: RoutingDocument,
	context: ScoreContext,
): RoutingEvidence {
	const exactName = containsExactName(
		context.normalizedExactQuery,
		document.normalizedName,
	);
	const matchedNameTerms = document.nameTerms.filter((term) =>
		context.queryTerms.has(term),
	);
	let nameScore = 0;
	if (exactName) {
		nameScore = 50;
	} else {
		const allNameTermsMatch =
			matchedNameTerms.length === document.nameTerms.length &&
			document.nameTerms.length > 0;
		nameScore = Math.min(
			12,
			matchedNameTerms.length * 4 + (allNameTermsMatch ? 4 : 0),
		);
	}
	const phraseScore = Math.min(
		8,
		[...document.bigrams].filter((value) => context.queryBigrams.has(value))
			.length * 2,
	);
	const bm25Score = bm25(document, context.queryTerms, context.index);
	const ngramScore = Math.min(
		6,
		overlapScore(document.characterNgrams, context.queryNgrams) * 6,
	);
	return {
		name: document.skill.name,
		score: nameScore + phraseScore + bm25Score + ngramScore,
		exactName,
		nameScore,
		phraseScore,
		bm25Score,
		ngramScore,
	};
}

function estimatedCandidateTokens(skill: RuntimeSkill): number {
	return estimateTokens({
		role: "user",
		content: [{ type: "text", text: `${skill.name}\n${skill.description}` }],
		timestamp: 0,
	});
}

function exactNames(evidence: readonly RoutingEvidence[]): string[] {
	return evidence
		.flatMap((item) => (item.exactName ? [item.name] : []))
		.toSorted(compareText);
}

function fullSelection(
	index: RoutingIndex,
	reason: string,
	evidence: readonly RoutingEvidence[] = [],
): RoutingSelection {
	return {
		describedSkills: index.documents.map((document) => document.skill),
		remainingNames: [],
		mandatoryNames: exactNames(evidence),
		fallback: true,
		reason,
		evidence,
	};
}

function emptySelection(): RoutingSelection {
	return {
		describedSkills: [],
		remainingNames: [],
		mandatoryNames: [],
		fallback: false,
		reason: "empty-registry",
		evidence: [],
	};
}

function scoreDocuments(
	index: RoutingIndex,
	query: RoutingQuery,
	segments: readonly string[],
): RoutingEvidence[] | undefined {
	const segmentTerms = segments.map((segment) =>
		terms(segment).filter((term) => !STOP_WORDS.has(term)),
	);
	const queryTermList = segmentTerms.flat();
	if (queryTermList.length === 0) return undefined;
	const queryBigrams = new Set<string>();
	const queryNgrams = new Set<string>();
	for (let index = 0; index < segments.length; index += 1) {
		for (const pair of adjacentPairs(segmentTerms[index] ?? [])) {
			queryBigrams.add(pair);
		}
		const segment = segments[index] ?? "";
		if (
			[...segment].some((character) => (character.codePointAt(0) ?? 0) > 0x7f)
		) {
			for (const ngram of characterNgrams(segment)) queryNgrams.add(ngram);
		}
	}
	const context: ScoreContext = {
		normalizedExactQuery: normalize(query.exactPrompt),
		queryTerms: countTerms(queryTermList),
		queryBigrams,
		queryNgrams,
		index,
	};
	return index.documents
		.map((document) => scoreDocument(document, context))
		.toSorted(
			(left, right) =>
				Number(right.exactName) - Number(left.exactName) ||
				right.score - left.score ||
				compareText(left.name, right.name),
		);
}

function confidenceFallbackReason(
	ranked: readonly RoutingEvidence[],
	pinnedCount: number,
): string | undefined {
	if (pinnedCount > 0) return undefined;
	const top = ranked[0];
	if (!top) return "low-confidence";
	const secondScore = ranked[1]?.score ?? 0;
	const weakSignal =
		top.score < MIN_SIGNAL_SCORE ||
		(top.score < MIN_CONFIDENT_SCORE && secondScore >= top.score * 0.5);
	if (weakSignal) return "low-confidence";
	const nearTieCount = ranked.filter(
		(item) => item.score >= top.score * NEAR_TIE_RATIO,
	).length;
	if (nearTieCount > MAX_DESCRIBED_SKILLS) return "ambiguous";
	return undefined;
}

interface CandidateChoice {
	readonly selected: Map<string, RuntimeSkill>;
	readonly fallbackReason?: string;
}

function chooseCandidates(
	index: RoutingIndex,
	evidence: readonly RoutingEvidence[],
	catalogTokenBudget: number,
): CandidateChoice {
	const byName = new Map(
		index.documents.map((document) => [document.skill.name, document.skill]),
	);
	const pinnedNames = exactNames(evidence);
	const ranked = evidence.filter((item) => !item.exactName && item.score > 0);
	const selected = new Map<string, RuntimeSkill>();
	let candidateTokens = 0;
	const budget =
		catalogTokenBudget === 0 ? Number.POSITIVE_INFINITY : catalogTokenBudget;

	for (const name of pinnedNames) {
		const skill = byName.get(name);
		if (!skill) continue;
		selected.set(name, skill);
		candidateTokens += estimatedCandidateTokens(skill);
	}

	const topRanked = ranked[0];
	const selectionFloor = !topRanked
		? Number.POSITIVE_INFINITY
		: topRanked.score < MIN_CONFIDENT_SCORE
			? topRanked.score * 0.5
			: Math.max(MIN_CONFIDENT_SCORE, topRanked.score * 0.3);

	const includedRanked: RoutingEvidence[] = [];
	for (const item of ranked) {
		if (item.score < selectionFloor) break;
		const skill = byName.get(item.name);
		if (!skill) continue;
		const skillTokens = estimatedCandidateTokens(skill);
		if (selected.size > 0 && candidateTokens + skillTokens > budget) {
			if (
				includedRanked.length > 0 &&
				item.score >= (includedRanked.at(-1)?.score ?? 0) * NEAR_TIE_RATIO
			) {
				return { selected, fallbackReason: "cutoff-ambiguity" };
			}
			break;
		}
		if (includedRanked.length >= MAX_DESCRIBED_SKILLS) {
			if (item.score >= (includedRanked.at(-1)?.score ?? 0) * NEAR_TIE_RATIO) {
				return { selected, fallbackReason: "cutoff-ambiguity" };
			}
			break;
		}
		selected.set(skill.name, skill);
		candidateTokens += skillTokens;
		includedRanked.push(item);
	}

	const lastIncluded = includedRanked.at(-1);
	const firstExcluded = ranked[includedRanked.length];
	if (
		lastIncluded &&
		firstExcluded &&
		firstExcluded.score >= lastIncluded.score * NEAR_TIE_RATIO
	) {
		return { selected, fallbackReason: "cutoff-ambiguity" };
	}

	return { selected };
}

function adaptiveSelection(
	index: RoutingIndex,
	evidence: readonly RoutingEvidence[],
	selected: ReadonlyMap<string, RuntimeSkill>,
): RoutingSelection {
	const mandatoryNames = exactNames(evidence);
	return {
		describedSkills: [...selected.values()].toSorted((left, right) =>
			compareText(left.name, right.name),
		),
		remainingNames: index.documents
			.flatMap((document) =>
				selected.has(document.skill.name) ? [] : [document.skill.name],
			)
			.toSorted(compareText),
		mandatoryNames,
		fallback: false,
		reason: mandatoryNames.length > 0 ? "exact-name" : "ranked",
		evidence,
	};
}

function mergeEvidence(
	batches: readonly (readonly RoutingEvidence[])[],
): RoutingEvidence[] {
	const best = new Map<string, RoutingEvidence>();
	for (const batch of batches) {
		for (const item of batch) {
			const current = best.get(item.name);
			if (
				!current ||
				Number(item.exactName) > Number(current.exactName) ||
				(item.exactName === current.exactName && item.score > current.score)
			) {
				best.set(item.name, item);
			}
		}
	}
	return [...best.values()].toSorted(
		(left, right) =>
			Number(right.exactName) - Number(left.exactName) ||
			right.score - left.score ||
			compareText(left.name, right.name),
	);
}

function selectFromEvidence(
	index: RoutingIndex,
	evidence: readonly RoutingEvidence[],
	catalogTokenBudget: number,
): RoutingSelection {
	const pinnedCount = exactNames(evidence).length;
	const ranked = evidence.filter((item) => !item.exactName);
	const fallbackReason = confidenceFallbackReason(ranked, pinnedCount);
	if (fallbackReason) return fullSelection(index, fallbackReason, evidence);
	const choice = chooseCandidates(index, evidence, catalogTokenBudget);
	if (choice.fallbackReason) {
		if (choice.selected.size > 0) {
			return {
				...adaptiveSelection(index, evidence, choice.selected),
				fallback: true,
				reason: choice.fallbackReason,
			};
		}
		return fullSelection(index, choice.fallbackReason, evidence);
	}
	if (choice.selected.size === 0)
		return fullSelection(index, "no-candidates", evidence);
	return adaptiveSelection(index, evidence, choice.selected);
}

function selectCoveringIntents(
	index: RoutingIndex,
	intents: readonly string[],
	catalogTokenBudget: number,
): RoutingSelection {
	const selected = new Map<string, RuntimeSkill>();
	const batches: RoutingEvidence[][] = [];
	let uncovered = false;
	for (const intent of intents) {
		const evidence = scoreDocuments(index, intentQuery(intent), [intent]);
		if (!evidence) {
			uncovered = true;
			continue;
		}
		batches.push(evidence);
		const choice = selectFromEvidence(index, evidence, catalogTokenBudget);
		const expanded =
			choice.fallback &&
			choice.describedSkills.length === index.documents.length;
		if (expanded) {
			const compact = chooseCandidates(index, evidence, catalogTokenBudget);
			if (compact.selected.size === 0) uncovered = true;
			for (const [name, skill] of compact.selected) selected.set(name, skill);
			continue;
		}
		for (const skill of choice.describedSkills) selected.set(skill.name, skill);
	}
	const evidence = mergeEvidence(batches);
	if (selected.size === 0) {
		return fullSelection(
			index,
			uncovered ? "uncovered-intent" : "no-candidates",
			evidence,
		);
	}
	return {
		...adaptiveSelection(index, evidence, selected),
		fallback: uncovered,
		reason: uncovered
			? "uncovered-intent"
			: exactNames(evidence).length > 0
				? "exact-name"
				: "ranked",
	};
}

export function selectRoutingSkills(
	index: RoutingIndex,
	query: RoutingQuery,
	catalogTokenBudget = DEFAULT_CATALOG_TOKEN_BUDGET,
): RoutingSelection {
	if (index.documents.length === 0) return emptySelection();
	const segments = querySegments(query);
	const combinedQuery = queryText(segments).trim();
	if (!combinedQuery) return fullSelection(index, "empty-query");

	try {
		const intents = splitIntents(query.currentPrompt);
		if (intents.length >= 2) {
			return selectCoveringIntents(index, intents, catalogTokenBudget);
		}
		const evidence = scoreDocuments(index, query, segments);
		if (!evidence) return fullSelection(index, "no-query-terms");
		return selectFromEvidence(index, evidence, catalogTokenBudget);
	} catch {
		return fullSelection(index, "retrieval-error");
	}
}

export function rankRoutingSkills(
	index: RoutingIndex,
	query: RoutingQuery,
): readonly RoutingEvidence[] {
	const segments = querySegments(query);
	return scoreDocuments(index, query, segments) ?? [];
}

export interface DiscloseAdaptiveInput {
	readonly index: RoutingIndex;
	readonly query: RoutingQuery;
	readonly modelVisible: readonly RuntimeSkill[];
	readonly safeCatalog: string;
	readonly safeCatalogTokens: number;
	readonly catalogTokenBudget: number;
	readonly explicitName?: string;
}

function catalogFits(
	tokens: number,
	budget: number,
): boolean {
	return budget === 0 || tokens <= budget;
}

function needsFullCatalog(selection: RoutingSelection): boolean {
	if (!selection.fallback) return false;
	return selection.reason !== "cutoff-ambiguity";
}

function shortlistFrom(
	allNames: readonly string[],
	skills: readonly RuntimeSkill[],
	reason: string,
	selection: RoutingSelection,
): AdaptiveDisclosure {
	const describedSkills = [...skills].toSorted((left, right) =>
		compareText(left.name, right.name),
	);
	const selected = new Set(describedSkills.map((skill) => skill.name));
	const remainingNames = allNames.filter((name) => !selected.has(name));
	const estimatedTokens = describedSkills.reduce(
		(total, skill) => total + estimatedCandidateTokens(skill),
		0,
	);
	return {
		strategy: "shortlist",
		reason,
		describedSkills,
		remainingNames,
		incomplete: remainingNames.length > 0,
		estimatedTokens,
		selection,
	};
}

export function safeLoadTargets(
	index: RoutingIndex,
	query: RoutingQuery,
): {
	readonly fullCatalog: boolean;
	readonly skills: readonly RuntimeSkill[];
} {
	const unlimited = selectRoutingSkills(index, query, 0);
	if (needsFullCatalog(unlimited)) {
		return { fullCatalog: true, skills: [] };
	}
	return { fullCatalog: false, skills: unlimited.describedSkills };
}

export function discloseAdaptiveCatalog(
	input: DiscloseAdaptiveInput,
): AdaptiveDisclosure {
	const allNames = input.modelVisible.map((skill) => skill.name);
	if (input.modelVisible.length === 0) {
		return {
			strategy: "full-catalog",
			reason: "empty-registry",
			describedSkills: [],
			remainingNames: [],
			incomplete: false,
			estimatedTokens: 0,
			selection: emptySelection(),
		};
	}

	if (catalogFits(input.safeCatalogTokens, input.catalogTokenBudget)) {
		return {
			strategy: "full-catalog",
			reason: "inexpensive-catalog",
			describedSkills: input.modelVisible,
			remainingNames: [],
			incomplete: false,
			estimatedTokens: input.safeCatalogTokens,
			selection: fullSelection(input.index, "inexpensive-catalog"),
		};
	}

	if (input.explicitName) {
		const pinned = input.modelVisible.find(
			(skill) => skill.name === input.explicitName,
		);
		if (pinned) {
			const remaining = allNames.filter((name) => name !== pinned.name);
			return {
				strategy: "explicit",
				reason: "explicit",
				describedSkills: [pinned],
				remainingNames: remaining,
				incomplete: remaining.length > 0,
				estimatedTokens: estimatedCandidateTokens(pinned),
				selection: {
					describedSkills: [pinned],
					remainingNames: remaining,
					mandatoryNames: [pinned.name],
					fallback: false,
					reason: "explicit",
					evidence: [],
				},
			};
		}
	}

	const targets = safeLoadTargets(input.index, input.query);
	if (targets.fullCatalog) {
		return {
			strategy: "full-catalog",
			reason: "safe-parity",
			describedSkills: input.modelVisible,
			remainingNames: [],
			incomplete: false,
			estimatedTokens: input.safeCatalogTokens,
			selection: fullSelection(input.index, "safe-parity"),
		};
	}

	const selection = selectRoutingSkills(
		input.index,
		input.query,
		input.catalogTokenBudget,
	);
	if (needsFullCatalog(selection)) {
		return {
			strategy: "full-catalog",
			reason: selection.reason,
			describedSkills: input.modelVisible,
			remainingNames: [],
			incomplete: false,
			estimatedTokens: input.safeCatalogTokens,
			selection,
		};
	}

	const required = new Map(
		selection.describedSkills.map((skill) => [skill.name, skill]),
	);
	for (const skill of targets.skills) required.set(skill.name, skill);
	return shortlistFrom(
		allNames,
		[...required.values()],
		selection.reason,
		selection,
	);
}
