import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { renderCompactCatalog, type RuntimeSkill } from "./src/catalog.ts";
import {
	buildRoutingIndex,
	buildRoutingQuery,
	discloseAdaptiveCatalog,
	safeLoadTargets,
	type AdaptiveDisclosure,
} from "./src/routing.ts";

const CORPUS = JSON.parse(
	readFileSync("test/fixtures/lazy-routing/corpus.json", "utf8"),
) as {
	skills: Array<{ name: string; description: string }>;
	cases: Array<{ prompt: string; expected: string[] }>;
};

function skill(name: string, description: string): RuntimeSkill {
	const filePath = resolve(`/skills/${name}/SKILL.md`);
	const baseDir = resolve(`/skills/${name}`);
	return {
		name,
		description,
		filePath,
		baseDir,
		disableModelInvocation: false,
		sourceInfo: {
			path: filePath,
			source: "test",
			scope: "temporary",
			origin: "top-level",
		},
	};
}

function paddedCatalog(base: readonly RuntimeSkill[]): RuntimeSkill[] {
	const fillers = Array.from({ length: 80 }, (_, index) =>
		skill(
			`filler-${String(index).padStart(3, "0")}`,
			`Office inbox filing, paper archives, and desk calendar reminders for filler ${index}. Not for dashboards, incidents, code review, or presentations.`,
		),
	);
	return [...base, ...fillers];
}

function disclose(
	skills: readonly RuntimeSkill[],
	prompt: string,
	history: Parameters<typeof buildRoutingQuery>[1] = [],
): AdaptiveDisclosure {
	return discloseAdaptiveCatalog({
		index: buildRoutingIndex(skills),
		query: buildRoutingQuery(prompt, history),
		modelVisible: skills,
		safeCatalog: renderCompactCatalog(skills),
		safeCatalogTokens: 50_000,
		catalogTokenBudget: 1200,
	});
}

function describedNames(disclosure: AdaptiveDisclosure): string[] {
	return disclosure.describedSkills.map((item) => item.name);
}

test("padded adaptive catalogs still describe every required corpus skill", () => {
	const skills = paddedCatalog(
		CORPUS.skills.map((item) => skill(item.name, item.description)),
	);
	const misses: string[] = [];
	for (const item of CORPUS.cases) {
		const disclosure = disclose(skills, item.prompt);
		const described = new Set(describedNames(disclosure));
		for (const name of item.expected) {
			if (described.has(name)) continue;
			misses.push(
				`${item.prompt} -> missing ${name} (${disclosure.strategy}/${disclosure.reason}: ${describedNames(disclosure).join(", ") || "none"})`,
			);
		}
	}
	assert.deepEqual(misses, []);
});

test("multi-skill and exclusion prompts keep required descriptions on a padded catalog", () => {
	const skills = paddedCatalog(
		CORPUS.skills.map((item) => skill(item.name, item.description)),
	);
	const multi = disclose(
		skills,
		"Create a Grafana dashboard with panels and variables while you investigate production latency using logs traces and metrics.",
	);
	assert.ok(describedNames(multi).includes("create-dashboard"));
	assert.ok(describedNames(multi).includes("debug-with-grafana"));

	const excluded = disclose(
		skills,
		"Review this diff only for over-engineering. Do not use pptx.",
	);
	assert.ok(describedNames(excluded).includes("ponytail-review"));
});

test("misleading names do not displace the skill whose description matches the task", () => {
	const skills = paddedCatalog([
		skill(
			"review",
			"Write restaurant reviews and dining critiques for local restaurants.",
		),
		skill(
			"ponytail-review",
			"Code review focused exclusively on over-engineering. Trigger on review for over-engineering.",
		),
	]);
	const disclosure = disclose(
		skills,
		"Review this diff only for over-engineering.",
	);
	assert.ok(describedNames(disclosure).includes("ponytail-review"));
});

test("no-skill prompts match safe by showing the full policy-filtered catalog", () => {
	const skills = paddedCatalog(
		CORPUS.skills.map((item) => skill(item.name, item.description)),
	);
	const disclosure = disclose(skills, "What is the capital of France?");
	assert.equal(disclosure.strategy, "full-catalog");
	assert.equal(disclosure.describedSkills.length, skills.length);
});

test("adaptive load targets match unlimited ranking and load before the dependent action", () => {
	const skills = paddedCatalog(
		CORPUS.skills.map((item) => skill(item.name, item.description)),
	);
	const index = buildRoutingIndex(skills);
	const misses: string[] = [];
	for (const item of CORPUS.cases) {
		const query = buildRoutingQuery(item.prompt);
		const targets = safeLoadTargets(index, query);
		const disclosure = disclose(skills, item.prompt);
		const described = new Set(describedNames(disclosure));
		if (targets.fullCatalog) {
			if (disclosure.strategy !== "full-catalog") {
				misses.push(`${item.prompt} -> expected full catalog for safe parity`);
			}
		} else {
			for (const required of targets.skills) {
				if (described.has(required.name)) continue;
				misses.push(
					`${item.prompt} -> missing load target ${required.name}`,
				);
			}
		}
		const loads: string[] = [];
		for (const name of item.expected) {
			if (!described.has(name) && disclosure.strategy !== "full-catalog") {
				misses.push(`${item.prompt} -> cannot load ${name} before acting`);
				continue;
			}
			loads.push(name);
		}
		const action = { type: "dependent-action" as const, after: loads.length };
		if (action.after !== item.expected.length) {
			misses.push(`${item.prompt} -> dependent action before all loads`);
		}
	}
	assert.deepEqual(misses, []);
});

test("topic changes describe the new task's skill without relying on stale history", () => {
	const skills = paddedCatalog(
		CORPUS.skills.map((item) => skill(item.name, item.description)),
	);
	const disclosure = disclose(
		skills,
		"Investigate production latency using logs traces and metrics.",
		[
			{
				type: "message",
				message: {
					role: "user",
					content: "Create a PowerPoint pitch deck.",
				},
			},
		] as never,
	);
	assert.ok(describedNames(disclosure).includes("debug-with-grafana"));
});

test("referential follow-ups still describe the required skill on a padded catalog", () => {
	const skills = paddedCatalog(
		CORPUS.skills.map((item) => skill(item.name, item.description)),
	);
	const disclosure = disclose(skills, "continue", [
		{
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Next we should create the slide deck." }],
			},
		},
	] as never);
	assert.ok(describedNames(disclosure).includes("pptx"));
});
