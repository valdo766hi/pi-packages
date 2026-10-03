import {
	renderSafeCatalog,
	type RuntimeSkill,
} from "./catalog.ts";
import { LazySkillError } from "./errors.ts";
import {
	buildRoutingQuery,
	rankRoutingSkills,
	type RoutingIndex,
} from "./routing.ts";
import type { SkillSnapshot } from "./snapshot.ts";

export const SEARCH_PAGE_SIZE = 10;
const MIN_SEARCH_SCORE = 0.8;

export interface SkillSearchParams {
	readonly query?: string;
	readonly cursor?: string;
}

export interface SkillSearchHit {
	readonly name: string;
	readonly description: string;
}

export interface SkillSearchPage {
	readonly skills: readonly SkillSearchHit[];
	readonly query: string;
	readonly offset: number;
	readonly hasMore: boolean;
	readonly nextCursor?: string;
	readonly weak: boolean;
	readonly mode: "browse" | "search";
	readonly total: number;
}

interface CursorPayload {
	readonly v: 1;
	readonly fingerprint: string;
	readonly query: string;
	readonly offset: number;
}

function compareText(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function encodeCursor(payload: CursorPayload): string {
	return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(
	cursor: string,
	fingerprint: string,
	query: string | undefined,
): CursorPayload {
	try {
		const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorPayload;
		if (
			!payload ||
			payload.v !== 1 ||
			payload.fingerprint !== fingerprint ||
			typeof payload.query !== "string" ||
			(query !== undefined && payload.query !== query) ||
			!Number.isSafeInteger(payload.offset) ||
			payload.offset < 0
		) throw new Error("Invalid cursor");
		return payload;
	} catch {
		throw new LazySkillError("SKILL_SEARCH_CURSOR_STALE");
	}
}

function hitsFromSkills(
	skills: readonly RuntimeSkill[],
): SkillSearchHit[] {
	return skills.map((skill) => ({
		name: skill.name,
		description: skill.description,
	}));
}

function pageFrom(
	ordered: readonly RuntimeSkill[],
	offset: number,
	fingerprint: string,
	query: string,
	mode: SkillSearchPage["mode"],
	weak: boolean,
): SkillSearchPage {
	const slice = ordered.slice(offset, offset + SEARCH_PAGE_SIZE);
	const nextOffset = offset + slice.length;
	const hasMore = nextOffset < ordered.length;
	return {
		skills: hitsFromSkills(slice),
		query,
		offset,
		hasMore,
		...(hasMore
			? {
					nextCursor: encodeCursor({
						v: 1,
						fingerprint,
						query,
						offset: nextOffset,
					}),
				}
			: {}),
		weak,
		mode,
		total: ordered.length,
	};
}

function orderedVisible(snapshot: SkillSnapshot): RuntimeSkill[] {
	return [...snapshot.modelVisible].toSorted((left, right) =>
		compareText(left.name, right.name),
	);
}

function rankedVisible(
	snapshot: SkillSnapshot,
	index: RoutingIndex,
	query: string,
): { skills: RuntimeSkill[]; weak: boolean } {
	const byName = new Map(
		snapshot.modelVisible.map((skill) => [skill.name, skill]),
	);
	const ranked = rankRoutingSkills(index, buildRoutingQuery(query));
	const skills = ranked.flatMap((item) => {
		const skill = byName.get(item.name);
		return skill && item.score > 0 ? [skill] : [];
	});
	const topScore = ranked[0]?.score ?? 0;
	return {
		skills,
		weak: skills.length === 0 || topScore < MIN_SEARCH_SCORE,
	};
}

export function searchSkills(
	snapshot: SkillSnapshot,
	params: SkillSearchParams = {},
): SkillSearchPage {
	if (!snapshot.policy.valid) throw new LazySkillError("POLICY_INVALID");
	const requestedQuery = params.query?.trim();
	const cursor = params.cursor
		? decodeCursor(params.cursor, snapshot.fingerprint, requestedQuery)
		: undefined;
	const query = requestedQuery ?? cursor?.query ?? "";
	const offset = cursor?.offset ?? 0;
	const browse = orderedVisible(snapshot);
	if (!query) {
		return pageFrom(
			browse,
			offset,
			snapshot.fingerprint,
			query,
			"browse",
			false,
		);
	}
	if (!snapshot.routingIndex) {
		return pageFrom(
			browse,
			offset,
			snapshot.fingerprint,
			query,
			"browse",
			true,
		);
	}
	const ranked = rankedVisible(snapshot, snapshot.routingIndex, query);
	if (ranked.weak && ranked.skills.length === 0) {
		return {
			...pageFrom(
				browse,
				offset,
				snapshot.fingerprint,
				query,
				"browse",
				true,
			),
			query,
		};
	}
	return pageFrom(
		ranked.skills,
		offset,
		snapshot.fingerprint,
		query,
		"search",
		ranked.weak,
	);
}

export function renderSearchPage(
	page: SkillSearchPage,
	skills: readonly RuntimeSkill[],
): string {
	const catalog = renderSafeCatalog(skills, { maxDescriptionCharacters: 0 });
	const names = page.skills.map((skill) => skill.name);
	let summary = "Search results are suggestions, not an exhaustive catalog.";
	if (page.mode === "browse") summary = "Browsing all policy-visible skill metadata.";
	else if (page.weak) {
		summary = "No strong search match. This does not mean no relevant skill exists. Browse with skill_search without a query, or try a different query.";
	}
	const lines = [
		catalog,
		summary,
		page.hasMore
			? "More results exist. Continue with the returned cursor."
			: "No further pages in this result set.",
		`names=${JSON.stringify(names)}`,
	];
	return lines.filter(Boolean).join("\n");
}
