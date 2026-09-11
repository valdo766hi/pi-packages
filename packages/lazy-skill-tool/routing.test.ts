import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import {
	formatSkillsForPrompt,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import {
	renderAdaptiveCatalog,
	renderCompactCatalog,
	type RuntimeSkill,
} from "./src/catalog.ts";
import { transformSkillPrompt } from "./src/prompt.ts";
import {
	buildRoutingIndex,
	buildRoutingQuery,
	discloseAdaptiveCatalog,
	selectRoutingSkills,
	type RoutingSelection,
} from "./src/routing.ts";

const CONFIG = { descriptionMax: 0 } as const;
const CORPUS = JSON.parse(
	readFileSync("test/fixtures/lazy-routing/corpus.json", "utf8"),
) as {
	skills: Array<{ name: string; description: string }>;
	cases: Array<{ prompt: string; expected: string[] }>;
};

function skill(
	name: string,
	description: string,
	disabled = false,
): Skill & RuntimeSkill {
	const filePath = resolve(`/skills/${name}/SKILL.md`);
	const baseDir = resolve(`/skills/${name}`);
	return {
		name,
		description,
		filePath,
		baseDir,
		disableModelInvocation: disabled,
		sourceInfo: {
			path: filePath,
			source: "test",
			scope: "temporary",
			origin: "top-level",
		},
	};
}

const representativeSkills = [
	skill(
		"ponytail",
		"Use on any coding task to choose the simplest solution and avoid over-engineering. Do not use for prose or general knowledge.",
	),
	skill(
		"ponytail-review",
		"Review code specifically for over-engineering and identify what to delete or replace with the standard library.",
	),
	skill(
		"pptx",
		"Create or edit PowerPoint presentations, slide decks, and presentation files. Also use for 日本語のプレゼンテーション資料を作成する依頼。",
	),
	skill(
		"debug-with-grafana",
		"Investigate production incidents using Grafana metrics, logs, traces, latency, and service telemetry.",
	),
	skill(
		"find-skills",
		"Find and install agent skills when users ask for new capabilities or whether a skill exists.",
	),
];

function names(selection: RoutingSelection): string[] {
	return selection.describedSkills.map((item) => item.name);
}

test("frozen representative corpus has complete recall without fallback", () => {
	const corpusSkills = CORPUS.skills.map((item) =>
		skill(item.name, item.description),
	);
	const index = buildRoutingIndex(corpusSkills);
	let fallbackCount = 0;
	for (const item of CORPUS.cases) {
		const selection = selectRoutingSkills(index, buildRoutingQuery(item.prompt));
		if (selection.fallback) fallbackCount += 1;
		const selected = names(selection);
		for (const expected of item.expected) {
			assert.ok(
				selected.includes(expected),
				`${item.prompt}: expected ${expected}, received ${selected.join(", ")}`,
			);
		}
	}
	assert.ok(fallbackCount / CORPUS.cases.length <= 0.1);
});

test("routing index internals are immutable snapshot data", () => {
	const index = buildRoutingIndex(representativeSkills);
	const document = index.documents[0];
	assert.ok(document);
	assert.ok(Object.isFrozen(index));
	assert.ok(Object.isFrozen(index.documents));
	assert.ok(Object.isFrozen(document));
	assert.ok(Object.isFrozen(document.nameTerms));
	assert.equal("set" in index.documentFrequency, false);
	assert.equal("set" in document.termCounts, false);
	assert.equal("add" in document.bigrams, false);
	assert.equal("add" in document.characterNgrams, false);
});

test("adaptive routing prioritizes exact names and preserves multiple mandatory names", () => {
	const extra = Array.from({ length: 8 }, (_, index) =>
		skill(`named-${index}`, `Specialized workflow number ${index}.`),
	);
	const index = buildRoutingIndex([...representativeSkills, ...extra]);
	const selection = selectRoutingSkills(
		index,
		buildRoutingQuery(
			"Load named-0, named-1, named-2, named-3, named-4, and named-5.",
		),
	);

	assert.equal(selection.fallback, false);
	assert.deepEqual(selection.mandatoryNames, [
		"named-0",
		"named-1",
		"named-2",
		"named-3",
		"named-4",
		"named-5",
	]);
	for (const name of selection.mandatoryNames) {
		assert.ok(names(selection).includes(name));
	}
	assert.ok(selection.describedSkills.length > 5);
});

test("nine or more non-exact near ties use the complete fallback", () => {
	const tied = Array.from({ length: 9 }, (_, index) =>
		skill(
			`ambiguous-${index}`,
			"Shared ambiguous workflow for evidence reconciliation.",
		),
	);
	const selection = selectRoutingSkills(
		buildRoutingIndex(tied),
		buildRoutingQuery("reconcile shared ambiguous workflow evidence"),
	);
	assert.equal(selection.fallback, true);
	assert.equal(selection.reason, "ambiguous");
	assert.equal(selection.describedSkills.length, 9);
	assert.deepEqual(selection.remainingNames, []);
});

test("an exact name anywhere in an oversized prompt remains mandatory", () => {
	const target = skill("target-skill", "Perform the target workflow safely.");
	const prompt = `${"irrelevant prefix telemetry ".repeat(700)} target-skill ${"trailing padding ".repeat(900)}`;
	const query = buildRoutingQuery(prompt);
	assert.ok(!query.currentPrompt.includes("target-skill"));
	assert.ok(query.exactPrompt.includes("target-skill"));
	const selection = selectRoutingSkills(
		buildRoutingIndex([
			target,
			skill("other-observer", "Inspect telemetry and irrelevant prefix data."),
		]),
		query,
	);
	assert.equal(selection.fallback, false);
	assert.deepEqual(selection.mandatoryNames, ["target-skill"]);
	assert.ok(names(selection).includes("target-skill"));
});

test("adaptive routing keeps the complete best overlapping candidate", () => {
	const selection = selectRoutingSkills(
		buildRoutingIndex(representativeSkills),
		buildRoutingQuery(
			"Review this code for over-engineering and needless abstractions.",
		),
	);

	assert.equal(selection.fallback, false);
	assert.deepEqual(names(selection), ["ponytail-review"]);
	assert.equal(
		selection.describedSkills.find((item) => item.name === "ponytail-review")
			?.description,
		representativeSkills[1]?.description,
	);
});

test("adaptive routing uses phrases, telemetry terms, and Unicode n-grams", () => {
	const index = buildRoutingIndex(representativeSkills);
	const cases = [
		["make a PowerPoint slide deck", "pptx"],
		[
			"investigate production latency using logs and traces",
			"debug-with-grafana",
		],
		["日本語のプレゼンテーション資料を作成", "pptx"],
	] as const;

	for (const [prompt, expected] of cases) {
		const selection = selectRoutingSkills(index, buildRoutingQuery(prompt));
		assert.equal(selection.fallback, false, prompt);
		assert.ok(names(selection).includes(expected), prompt);
	}
});

test("recent user, assistant, and summary context resolves short follow-ups", () => {
	const entries = [
		{
			type: "compaction",
			summary: "The user is preparing a quarterly presentation.",
		},
		{
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Next we should create the slide deck." }],
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				content: [{ type: "text", text: "debug-with-grafana logs traces" }],
			},
		},
	] as const;
	const query = buildRoutingQuery(
		"continue",
		entries as unknown as Parameters<typeof buildRoutingQuery>[1],
	);
	assert.deepEqual(query.summaries, [
		"The user is preparing a quarterly presentation.",
	]);
	assert.deepEqual(query.recentAssistantText, [
		"Next we should create the slide deck.",
	]);
	const selection = selectRoutingSkills(
		buildRoutingIndex(representativeSkills),
		query,
	);
	assert.equal(selection.fallback, false);
	assert.ok(names(selection).includes("pptx"));
	assert.ok(!names(selection).includes("debug-with-grafana"));
});

test("standalone current input excludes stale history and phrases never cross messages", () => {
	const entries = [
		{
			type: "message",
			message: {
				role: "user",
				content: "Create a PowerPoint presentation slide deck.",
			},
		},
		{
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "production" }],
			},
		},
	] as const;
	const selection = selectRoutingSkills(
		buildRoutingIndex(representativeSkills),
		buildRoutingQuery(
			"Investigate latency using logs and traces.",
			entries as unknown as Parameters<typeof buildRoutingQuery>[1],
		),
	);
	assert.equal(selection.fallback, false);
	assert.ok(names(selection).includes("debug-with-grafana"));
	assert.ok(!names(selection).includes("pptx"));

	const specificFollowUp = selectRoutingSkills(
		buildRoutingIndex(representativeSkills),
		buildRoutingQuery(
			"Now use this to investigate latency using logs and traces.",
			[
				{
					type: "message",
					message: {
						role: "user",
						content: "Create a PowerPoint presentation slide deck. ".repeat(100),
					},
				},
			] as unknown as Parameters<typeof buildRoutingQuery>[1],
		),
	);
	assert.deepEqual(names(specificFollowUp), ["debug-with-grafana"]);

	const referential = buildRoutingQuery("continue", [
		{
			type: "message",
			message: { role: "user", content: "production" },
		},
		{
			type: "message",
			message: { role: "user", content: "latency" },
		},
	] as unknown as Parameters<typeof buildRoutingQuery>[1]);
	const evidence = selectRoutingSkills(
		buildRoutingIndex([
			skill("phrase-only", "Handle production latency incidents."),
		]),
		referential,
	).evidence[0];
	assert.equal(evidence?.phraseScore, 0);
});

test("uncertain and empty queries preserve the complete catalog", () => {
	const index = buildRoutingIndex(representativeSkills);
	for (const prompt of ["", "What is the capital of France?"]) {
		const selection = selectRoutingSkills(index, buildRoutingQuery(prompt));
		assert.equal(selection.fallback, true);
		assert.deepEqual(
			names(selection),
			representativeSkills.map((item) => item.name).toSorted(),
		);
		assert.deepEqual(selection.remainingNames, []);
	}
});

test("exact-name pinning does not raise the score floor for unrelated candidates", () => {
	const pinned = skill(
		"deploy",
		"Ship application releases to production clusters.",
	);
	const relevant = skill(
		"postgres",
		"Investigate database connection exhaustion, pooling, and idle client storms.",
	);
	const filler = Array.from({ length: 8 }, (_, index) =>
		skill(
			`filler-${index}`,
			"Generic helper for unrelated office documentation tasks.",
		),
	);
	const selection = selectRoutingSkills(
		buildRoutingIndex([pinned, relevant, ...filler]),
		buildRoutingQuery(
			"Use deploy while you investigate database connection exhaustion.",
		),
	);
	assert.equal(selection.fallback, false);
	assert.deepEqual(selection.mandatoryNames, ["deploy"]);
	assert.ok(names(selection).includes("deploy"));
	assert.ok(names(selection).includes("postgres"));
});

test("multi-intent prompts describe each clause's skill instead of top-one coverage", () => {
	const selection = selectRoutingSkills(
		buildRoutingIndex(representativeSkills),
		buildRoutingQuery(
			"Create a PowerPoint slide deck while you investigate production latency using logs and traces.",
		),
	);
	assert.equal(selection.fallback, false);
	assert.ok(names(selection).includes("pptx"));
	assert.ok(names(selection).includes("debug-with-grafana"));
});

test("exact-name priority resists keyword-stuffed descriptions", () => {
	const stuffed = skill(
		"spam",
		"review code over engineering delete standard library ".repeat(500),
	);
	const selection = selectRoutingSkills(
		buildRoutingIndex([...representativeSkills, stuffed]),
		buildRoutingQuery("Use ponytail-review for this code."),
	);
	assert.equal(selection.evidence[0]?.name, "ponytail-review");
	assert.equal(selection.evidence[0]?.exactName, true);
	assert.ok(names(selection).includes("ponytail-review"));
});

test("adaptive catalog round-trips every remaining exact name", () => {
	const described = [skill("alpha", "Complete alpha routing description.")];
	const remaining = ["line\nbreak", "tab\tname", "nul\0name", 'a&<"b'];
	const catalog = renderAdaptiveCatalog(described, remaining, CONFIG);
	const encoded = catalog.match(
		/<other_skill_names>(.*)<\/other_skill_names>/u,
	)?.[1];
	assert.ok(encoded);
	const decoded = encoded
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&");
	assert.deepEqual(JSON.parse(decoded), remaining.toSorted());
	assert.ok(catalog.includes("Complete alpha routing description."));
});

test("prompt validation uses the full snapshot while rendering candidates", () => {
	const snapshot = [
		skill("alpha", "Complete alpha description."),
		skill("beta", "Complete beta description."),
		skill("gamma", "Complete gamma description."),
	];
	const selection: RoutingSelection = {
		describedSkills: [snapshot[0]!],
		remainingNames: ["beta", "gamma"],
		mandatoryNames: ["alpha"],
		fallback: false,
		reason: "exact-name",
		evidence: [],
	};
	const result = transformSkillPrompt(
		formatSkillsForPrompt(snapshot),
		snapshot,
		CONFIG,
		selection,
	);
	assert.equal(result.replaced, true);
	assert.ok(result.prompt.includes("Complete alpha description."));
	assert.ok(!result.prompt.includes("Complete beta description."));
	assert.ok(result.prompt.includes('["beta","gamma"]'));
	assert.ok(!result.prompt.includes("/skills/beta/SKILL.md"));
});

test("adaptive disclosure uses the catalog token budget instead of a skill-count cutoff", () => {
	const skills = Array.from({ length: 6 }, (_, index) =>
		skill(
			`budget-${index}`,
			`Complete description for budget skill ${index} with enough routing text to accumulate tokens.`,
		),
	);
	const index = buildRoutingIndex(skills);
	const query = buildRoutingQuery("What is the capital of France?");
	const inexpensive = discloseAdaptiveCatalog({
		index,
		query,
		modelVisible: skills,
		safeCatalog: renderCompactCatalog(skills),
		safeCatalogTokens: 100,
		catalogTokenBudget: 2048,
	});
	assert.equal(inexpensive.strategy, "full-catalog");
	assert.equal(inexpensive.incomplete, false);
	assert.equal(inexpensive.describedSkills.length, 6);

	const paginated = discloseAdaptiveCatalog({
		index,
		query,
		modelVisible: skills,
		safeCatalog: renderCompactCatalog(skills),
		safeCatalogTokens: 5000,
		catalogTokenBudget: 200,
	});
	assert.equal(paginated.strategy, "full-catalog");
	assert.equal(paginated.incomplete, false);
	assert.equal(paginated.describedSkills.length, 6);
});

test("large-catalog cutoff ambiguity keeps pinned descriptions instead of emptying the catalog", () => {
	const pinned = skill(
		"skill-000",
		"Use this skill for focused workflow 0, validation, and related project tasks.",
	);
	const neighbors = Array.from({ length: 40 }, (_, index) =>
		skill(
			`skill-${String(index + 1).padStart(3, "0")}`,
			`Use this skill for focused workflow ${index + 1}, validation, and related project tasks.`,
		),
	);
	const skills = [pinned, ...neighbors];
	const disclosure = discloseAdaptiveCatalog({
		index: buildRoutingIndex(skills),
		query: buildRoutingQuery(
			"Run workflow-0 with skill-000 and verify its evidence.",
		),
		modelVisible: skills,
		safeCatalog: renderCompactCatalog(skills),
		safeCatalogTokens: 5000,
		catalogTokenBudget: 200,
	});
	assert.notEqual(disclosure.strategy, "paginated");
	assert.ok(disclosure.describedSkills.some((item) => item.name === "skill-000"));
	assert.equal(disclosure.incomplete, true);
});

test("full fallback renders the approved complete catalog", () => {
	const full = renderCompactCatalog(representativeSkills, CONFIG);
	const fallback: RoutingSelection = {
		describedSkills: representativeSkills,
		remainingNames: [],
		mandatoryNames: [],
		fallback: true,
		reason: "low-confidence",
		evidence: [],
	};
	const transformed = transformSkillPrompt(
		formatSkillsForPrompt(representativeSkills),
		representativeSkills,
		CONFIG,
		fallback,
	);
	assert.ok(transformed.prompt.includes(full));
});
