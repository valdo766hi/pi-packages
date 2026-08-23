import {
	estimateTokens,
	type SessionEntry,
	type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { RuntimeSkill } from "./catalog.ts";

const MAX_DESCRIBED_SKILLS = 5;
const MAX_CANDIDATE_TOKENS = 1_100;
const MAX_QUERY_CHARACTERS = 12_000;
const MAX_RECENT_USER_MESSAGES = 4;
const MAX_RECENT_ASSISTANT_MESSAGES = 2;
const MAX_SUMMARIES = 2;
const MIN_CONFIDENT_SCORE = 4;
const MIN_SIGNAL_SCORE = 0.8;
const NEAR_TIE_RATIO = 0.9;
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

function normalize(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase("en-US");
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

function textFromMessage(
	message: SessionMessageEntry["message"],
): string {
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
	for (let index = values.length - 1; index >= 0 && result.length < limit; index -= 1) {
		const value = values[index]?.trim();
		if (!value) continue;
		const characters = [...value];
		const bounded = characters.slice(Math.max(0, characters.length - remaining)).join("");
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
		recentAssistantText: boundedRecent(
			assistants,
			MAX_RECENT_ASSISTANT_MESSAGES,
		),
		summaries: boundedRecent(summaries, MAX_SUMMARIES),
	};
}

export function buildRoutingIndex(
	skills: readonly RuntimeSkill[],
): RoutingIndex {
	const documents = skills
		.flatMap((skill): RoutingDocument[] => {
			if (skill.disableModelInvocation) return [];
			const descriptionTerms = terms(skill.description);
			const nameTerms = terms(skill.name.replaceAll("-", " "));
			return [{
				skill,
				normalizedName: normalize(skill.name),
				nameTerms,
				termCounts: countTerms(descriptionTerms),
				bigrams: adjacentPairs(descriptionTerms),
				characterNgrams: characterNgrams(
					`${skill.name} ${skill.description}`,
				),
				termCount: descriptionTerms.length,
			}];
		})
		.toSorted((left, right) => left.skill.name.localeCompare(right.skill.name));

	const documentFrequency = new Map<string, number>();
	let totalTerms = 0;
	for (const document of documents) {
		totalTerms += document.termCount;
		for (const term of document.termCounts.keys()) {
			documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
		}
	}
	return {
		documents,
		documentFrequency,
		averageDocumentLength:
			documents.length === 0 ? 0 : totalTerms / documents.length,
	};
}

function queryText(query: RoutingQuery): string {
	const combined = [
		...query.summaries,
		...query.recentUserText,
		...query.recentAssistantText,
		query.currentPrompt,
	]
		.filter(Boolean)
		.join("\n");
	const characters = [...combined];
	return characters.slice(Math.max(0, characters.length - MAX_QUERY_CHARACTERS)).join("");
}

function containsExactName(normalizedQuery: string, normalizedName: string): boolean {
	if (normalizedName.length === 0) return false;
	let cursor = normalizedQuery.indexOf(normalizedName);
	while (cursor !== -1) {
		const before = cursor === 0 ? "" : normalizedQuery[cursor - 1] ?? "";
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
	if (index.documents.length === 0 || index.averageDocumentLength === 0) return 0;
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
			k1 *
				(1 - b + b * (document.termCount / index.averageDocumentLength));
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
		[...document.bigrams].filter((value) =>
			context.queryBigrams.has(value),
		).length * 2,
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
		.toSorted((left, right) => left.localeCompare(right));
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
	combinedQuery: string,
): RoutingEvidence[] | undefined {
	const queryTermList = terms(combinedQuery).filter(
		(term) => !STOP_WORDS.has(term),
	);
	if (queryTermList.length === 0) return undefined;
	const context: ScoreContext = {
		normalizedExactQuery: normalize(query.exactPrompt),
		queryTerms: countTerms(queryTermList),
		queryBigrams: adjacentPairs(queryTermList),
		queryNgrams: [...combinedQuery].some(
			(character) => (character.codePointAt(0) ?? 0) > 0x7f,
		)
			? characterNgrams(combinedQuery)
			: new Set(),
		index,
	};
	return index.documents
		.map((document) => scoreDocument(document, context))
		.toSorted(
			(left, right) =>
				Number(right.exactName) - Number(left.exactName) ||
				right.score - left.score ||
				left.name.localeCompare(right.name),
		);
}

function confidenceFallbackReason(
	evidence: readonly RoutingEvidence[],
): string | undefined {
	const top = evidence[0];
	if (!top) return "low-confidence";
	const secondScore = evidence[1]?.score ?? 0;
	const weakSignal =
		top.score < MIN_SIGNAL_SCORE ||
		(top.score < MIN_CONFIDENT_SCORE && secondScore >= top.score * 0.5);
	if (!top.exactName && weakSignal) return "low-confidence";
	const mandatoryCount = exactNames(evidence).length;
	const nearTieCount = evidence.filter(
		(item) => item.score >= top.score * NEAR_TIE_RATIO,
	).length;
	if (mandatoryCount === 0 && nearTieCount > MAX_DESCRIBED_SKILLS) {
		return "ambiguous";
	}
	return undefined;
}

function chooseCandidates(
	index: RoutingIndex,
	evidence: readonly RoutingEvidence[],
): Map<string, RuntimeSkill> {
	const topScore = evidence[0]?.score ?? 0;
	const selectionFloor =
		topScore < MIN_CONFIDENT_SCORE
			? topScore * 0.5
			: Math.max(MIN_CONFIDENT_SCORE, topScore * 0.3);
	const byName = new Map(
		index.documents.map((document) => [document.skill.name, document.skill]),
	);
	const selected = new Map<string, RuntimeSkill>();
	let candidateTokens = 0;
	for (const name of exactNames(evidence)) {
		const skill = byName.get(name);
		if (!skill) continue;
		selected.set(name, skill);
		candidateTokens += estimatedCandidateTokens(skill);
	}
	for (const item of evidence) {
		if (selected.has(item.name) || item.score <= 0) continue;
		if (selected.size >= MAX_DESCRIBED_SKILLS) break;
		if (item.score < selectionFloor) break;
		const skill = byName.get(item.name);
		if (!skill) continue;
		const skillTokens = estimatedCandidateTokens(skill);
		const exceedsBudget =
			selected.size > 0 &&
			candidateTokens + skillTokens > MAX_CANDIDATE_TOKENS;
		if (exceedsBudget) continue;
		selected.set(skill.name, skill);
		candidateTokens += skillTokens;
	}
	return selected;
}

function adaptiveSelection(
	index: RoutingIndex,
	evidence: readonly RoutingEvidence[],
	selected: ReadonlyMap<string, RuntimeSkill>,
): RoutingSelection {
	const mandatoryNames = exactNames(evidence);
	return {
		describedSkills: [...selected.values()].toSorted((left, right) =>
			left.name.localeCompare(right.name),
		),
		remainingNames: index.documents
			.flatMap((document) =>
				selected.has(document.skill.name) ? [] : [document.skill.name],
			)
			.toSorted((left, right) => left.localeCompare(right)),
		mandatoryNames,
		fallback: false,
		reason: mandatoryNames.length > 0 ? "exact-name" : "ranked",
		evidence,
	};
}

export function selectRoutingSkills(
	index: RoutingIndex,
	query: RoutingQuery,
): RoutingSelection {
	if (index.documents.length === 0) return emptySelection();
	const combinedQuery = queryText(query).trim();
	if (!combinedQuery) return fullSelection(index, "empty-query");

	try {
		const evidence = scoreDocuments(index, query, combinedQuery);
		if (!evidence) return fullSelection(index, "no-query-terms");
		const fallbackReason = confidenceFallbackReason(evidence);
		if (fallbackReason) return fullSelection(index, fallbackReason, evidence);
		const selected = chooseCandidates(index, evidence);
		if (selected.size === 0) return fullSelection(index, "no-candidates", evidence);
		return adaptiveSelection(index, evidence, selected);
	} catch {
		return fullSelection(index, "retrieval-error");
	}
}
