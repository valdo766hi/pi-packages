import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import {
	formatSkillsForPrompt,
	loadSkillsFromDir,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_DESCRIPTION_MAX,
	DEFAULT_FILE_LIMIT,
	renderCompactCatalog,
} from "../packages/lazy-skill-tool/src/catalog.ts";
import lazySkillTool from "../packages/lazy-skill-tool/src/index.ts";
import { loadSkill } from "../packages/lazy-skill-tool/src/loader.ts";

const fixtureRoot = resolve("test/fixtures/lazy-skills");
const realWorldFixtureRoot = resolve("test/fixtures/lazy-real-world");
const skills = loadSkillsFromDir({
	dir: fixtureRoot,
	source: "benchmark",
}).skills;
const realWorldSkills = loadSkillsFromDir({
	dir: realWorldFixtureRoot,
	source: "benchmark-real-world",
}).skills;
const selectedSkill = skills.find((skill) => skill.name === "alpha");
if (!selectedSkill)
	throw new Error("Benchmark fixture skill alpha is missing.");

const RECORDED_BASELINE = {
	gitHead: "5be8af4",
	defaultLoadP50Ms: 0.235,
	defaultLoadP95Ms: 0.592,
	performanceRating: 6.8,
};
const WARMUP_ITERATIONS = 25;
const MEASURED_ITERATIONS = 500;

function bytes(value) {
	return Buffer.byteLength(value, "utf8");
}

function reduction(before, after) {
	return ((1 - after / before) * 100).toFixed(1);
}

function percentile(sorted, fraction) {
	return sorted[
		Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
	];
}

async function measure(operation) {
	for (let index = 0; index < WARMUP_ITERATIONS; index += 1) await operation();

	const samples = [];
	for (let index = 0; index < MEASURED_ITERATIONS; index += 1) {
		const started = performance.now();
		await operation();
		samples.push(performance.now() - started);
	}
	samples.sort((left, right) => left - right);
	return {
		p50: percentile(samples, 0.5).toFixed(3),
		p95: percentile(samples, 0.95).toFixed(3),
	};
}

function syntheticSkills(count) {
	return Array.from({ length: count }, (_, index) => ({
		name: `skill-${String(index).padStart(3, "0")}`,
		description: `Use this skill for focused workflow ${index}, validation, and related project tasks.`,
		filePath: resolve(`/tmp/skills/skill-${index}/SKILL.md`),
		baseDir: resolve(`/tmp/skills/skill-${index}`),
		sourceInfo: {
			path: "<benchmark>",
			source: "benchmark",
			scope: "temporary",
			origin: "top-level",
		},
		disableModelInvocation: false,
	}));
}

function createToolHarness() {
	const handlers = new Map();
	let tool;
	const previousLimit = process.env.PI_LAZY_SKILL_FILE_LIMIT;
	const previousDisabled = process.env.PI_LAZY_SKILL_DISABLE;
	delete process.env.PI_LAZY_SKILL_FILE_LIMIT;
	delete process.env.PI_LAZY_SKILL_DISABLE;
	try {
		lazySkillTool({
			registerTool(definition) {
				tool = definition;
			},
			on(event, handler) {
				handlers.set(event, handler);
			},
		});
	} finally {
		if (previousLimit === undefined) delete process.env.PI_LAZY_SKILL_FILE_LIMIT;
		else process.env.PI_LAZY_SKILL_FILE_LIMIT = previousLimit;
		if (previousDisabled === undefined) delete process.env.PI_LAZY_SKILL_DISABLE;
		else process.env.PI_LAZY_SKILL_DISABLE = previousDisabled;
	}
	const before = handlers.get("before_agent_start");
	if (!tool || typeof before !== "function") {
		throw new Error("Skill tool benchmark harness did not initialize.");
	}
	return { tool, before };
}

function catalogRow(label, catalogSkills) {
	const nativeCatalog = formatSkillsForPrompt(catalogSkills);
	const compactCatalog = renderCompactCatalog(catalogSkills, {
		descriptionMax: DEFAULT_DESCRIPTION_MAX,
	});
	return {
		label,
		native: bytes(nativeCatalog),
		compact: bytes(compactCatalog),
		reduction: reduction(bytes(nativeCatalog), bytes(compactCatalog)),
	};
}

const catalogRows = [
	catalogRow(`fixtures (${skills.length})`, skills),
	catalogRow(`real-world (${realWorldSkills.length})`, realWorldSkills),
	...[10, 50, 100].map((count) =>
		catalogRow(`synthetic (${count})`, syntheticSkills(count)),
	),
];
const rawRead = await measure(async () => {
	const content = await readFile(selectedSkill.filePath, "utf8");
	parseFrontmatter(content).body.trim();
});
const defaultLoad = await measure(() =>
	loadSkill(selectedSkill, DEFAULT_FILE_LIMIT),
);
const sampledLoad = await measure(() => loadSkill(selectedSkill, 10));
const harness = createToolHarness();
await harness.before({
	systemPrompt: formatSkillsForPrompt(skills),
	systemPromptOptions: {
		cwd: fixtureRoot,
		skills,
		selectedTools: ["skill"],
	},
});
const fullToolLoad = await measure(() =>
	harness.tool.execute("benchmark", { name: selectedSkill.name }),
);
const fullToolResult = await harness.tool.execute("benchmark", {
	name: selectedSkill.name,
});
const fullToolBytes = bytes(
	fullToolResult.content.map((item) => item.text ?? "").join("\n"),
);

process.stdout.write(
	[
		`Recorded baseline: ${RECORDED_BASELINE.gitHead} (performance ${RECORDED_BASELINE.performanceRating}/10)`,
		"",
		"Catalog-only bytes (Pi native -> compact; tool schema excluded):",
		...catalogRows.map(
			(row) =>
				`  ${row.label.padEnd(16)} ${String(row.native).padStart(6)} -> ${String(row.compact).padStart(6)} (${row.reduction}% reduction)`,
		),
		"",
		`Warm selected-skill load (${MEASURED_ITERATIONS} iterations, milliseconds):`,
		`  raw read + parse       p50 ${rawRead.p50}  p95 ${rawRead.p95}`,
		`  default (limit=${DEFAULT_FILE_LIMIT})      p50 ${defaultLoad.p50}  p95 ${defaultLoad.p95}`,
		`  sampled (limit=10)     p50 ${sampledLoad.p50}  p95 ${sampledLoad.p95}`,
		`  full default tool      p50 ${fullToolLoad.p50}  p95 ${fullToolLoad.p95} (${fullToolBytes} result bytes)`,
		`  recorded old default   p50 ${RECORDED_BASELINE.defaultLoadP50Ms.toFixed(3)}  p95 ${RECORDED_BASELINE.defaultLoadP95Ms.toFixed(3)}`,
		"",
		"Timing is machine-specific; compare runs on the same workstation.",
		"Catalog byte reductions exclude the additional skill tool schema.",
		"",
	].join("\n"),
);
