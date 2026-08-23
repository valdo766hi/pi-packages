import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { performance } from "node:perf_hooks";
import { dirname, join, resolve } from "node:path";
import {
	createReadToolDefinition,
	estimateTokens,
	formatSkillsForPrompt,
	loadSkillsFromDir,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	DEFAULT_DESCRIPTION_MAX,
	DEFAULT_FILE_LIMIT,
	renderAdaptiveCatalog,
	renderCompactCatalog,
} from "../packages/lazy-skill-tool/src/catalog.ts";
import lazySkillTool from "../packages/lazy-skill-tool/src/index.ts";
import { loadSkill } from "../packages/lazy-skill-tool/src/loader.ts";
import {
	buildRoutingIndex,
	buildRoutingQuery,
	selectRoutingSkills,
} from "../packages/lazy-skill-tool/src/routing.ts";
import { sampleRelatedFiles } from "../packages/lazy-skill-tool/src/files.ts";

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
if (!selectedSkill) throw new Error("Benchmark fixture skill alpha is missing.");

const RECORDED_PERFORMANCE_BASELINE = {
	gitHead: "5be8af4",
	defaultLoadP50Ms: 0.235,
	defaultLoadP95Ms: 0.592,
	performanceRating: 6.8,
};
const LEGACY_DESCRIPTION_MAX = 240;
const WARMUP_ITERATIONS = 25;
const MEASURED_ITERATIONS = 500;

function bytes(value) {
	return Buffer.byteLength(value, "utf8");
}

function tokens(value) {
	return estimateTokens({
		role: "user",
		content: [{ type: "text", text: value }],
		timestamp: 0,
	});
}

function serializeToolDefinition(tool) {
	return JSON.stringify({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	});
}

function resultText(result) {
	return result.content.map((item) => item.text ?? "").join("\n");
}

function resultContext(result) {
	try {
		return JSON.parse(result.content[1]?.text ?? "{}");
	} catch (error) {
		throw new Error("Skill benchmark result contained invalid JSON context.", {
			cause: error,
		});
	}
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
		description: `Use this skill for focused workflow ${index}, validation, and related project tasks. Trigger on workflow-${index}, exact evidence review, and safe execution.`,
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
	const previous = {
		limit: process.env.PI_LAZY_SKILL_FILE_LIMIT,
		disabled: process.env.PI_LAZY_SKILL_DISABLE,
		routing: process.env.PI_LAZY_SKILL_ROUTING,
	};
	delete process.env.PI_LAZY_SKILL_FILE_LIMIT;
	delete process.env.PI_LAZY_SKILL_DISABLE;
	delete process.env.PI_LAZY_SKILL_ROUTING;
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
		for (const [key, value] of Object.entries({
			PI_LAZY_SKILL_FILE_LIMIT: previous.limit,
			PI_LAZY_SKILL_DISABLE: previous.disabled,
			PI_LAZY_SKILL_ROUTING: previous.routing,
		})) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
	const handler = handlers.get("before_agent_start");
	if (!tool || typeof handler !== "function") {
		throw new Error("Skill tool benchmark harness did not initialize.");
	}
	return {
		tool,
		before(event, entries = []) {
			return handler(event, {
				sessionManager: { buildContextEntries: () => entries },
			});
		},
	};
}

function escapeXml(value) {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function compactLegacyDescription(description) {
	const normalized = description.replace(/\s+/gu, " ").trim();
	const characters = [...normalized];
	if (characters.length <= LEGACY_DESCRIPTION_MAX) return normalized;
	let shortened = characters
		.slice(0, LEGACY_DESCRIPTION_MAX - 1)
		.join("")
		.trimEnd();
	const boundary = shortened.lastIndexOf(" ");
	if (boundary > 0) shortened = shortened.slice(0, boundary).trimEnd();
	return `${shortened}…`;
}

function legacyCatalog(catalogSkills) {
	const visible = catalogSkills
		.filter((skill) => !skill.disableModelInvocation)
		.toSorted((left, right) => left.name.localeCompare(right.name));
	return [
		"The following skills provide specialized instructions for specific tasks.",
		"When a task matches a skill's description, use the `skill` tool with that exact skill name before proceeding.",
		"When a skill references a relative path, resolve it from the base directory returned by the `skill` tool.",
		"",
		"<available_skills>",
		...visible.flatMap((skill) => [
			"  <skill>",
			`    <name>${escapeXml(skill.name)}</name>`,
			`    <description>${escapeXml(compactLegacyDescription(skill.description))}</description>`,
			"  </skill>",
		]),
		"</available_skills>",
	].join("\n");
}

const LEGACY_TOOL = {
	name: "skill",
	description:
		"Load a specialized skill when the task matches a skill listed in <available_skills>. Use the exact skill name. The tool returns the complete skill instructions, base directory, and sampled related resources.",
	parameters: Type.Object(
		{
			name: Type.String({
				description: "Exact skill name from available_skills",
				minLength: 1,
			}),
		},
		{ additionalProperties: false },
	),
};
const legacyToolSchema = serializeToolDefinition(LEGACY_TOOL);
const FULL_015_TOOL = {
	name: "skill",
	description:
		"Load a listed skill; use returned next offset/column to continue.",
	parameters: Type.Object(
		{
			name: Type.String({ minLength: 1 }),
			offset: Type.Optional(Type.Integer({ minimum: 1 })),
			column: Type.Optional(Type.Integer({ minimum: 1 })),
		},
		{ additionalProperties: false },
	),
};
const full015ToolSchema = serializeToolDefinition(FULL_015_TOOL);

async function legacyResult(skill) {
	const raw = await readFile(skill.filePath, "utf8");
	const body = parseFrontmatter(raw).body.trim();
	const related = await sampleRelatedFiles(skill.baseDir, skill.filePath, 10);
	const sampled = related.truncated || related.files.length > 0;
	return [
		`<skill_content name="${escapeXml(skill.name)}">`,
		`# Skill: ${escapeXml(skill.name)}`,
		"",
		"<skill_body><![CDATA[",
		body.replaceAll("]]>", "]]]]><![CDATA[>"),
		"]]></skill_body>",
		"",
		`Base directory for this skill: ${escapeXml(skill.baseDir)}`,
		"Relative paths referenced by this skill are relative to this base directory.",
		`Note: related file list is sampled${sampled ? "." : " and empty."}`,
		"",
		`<skill_files sampled="${sampled ? "true" : "false"}">`,
		...related.files.map((file) => `  <file>${escapeXml(file)}</file>`),
		"</skill_files>",
		"</skill_content>",
	].join("\n");
}

function adaptiveCatalog(catalogSkills, prompt) {
	const selection = selectRoutingSkills(
		buildRoutingIndex(catalogSkills),
		buildRoutingQuery(prompt),
	);
	return {
		selection,
		catalog: selection.fallback
			? renderCompactCatalog(catalogSkills, {
					descriptionMax: DEFAULT_DESCRIPTION_MAX,
				})
			: renderAdaptiveCatalog(
					selection.describedSkills,
					selection.remainingNames,
					{ descriptionMax: DEFAULT_DESCRIPTION_MAX },
				),
	};
}

function variant(label, catalog, schema, args, result) {
	const staticBytes = bytes(catalog) + bytes(schema);
	const staticTokens = tokens(catalog) + tokens(schema);
	const exchangeBytes = bytes(args) + bytes(result);
	const exchangeTokens = tokens(args) + tokens(result);
	const postSkillBytes = staticBytes + exchangeBytes;
	const postSkillTokens = staticTokens + exchangeTokens;
	return {
		label,
		staticBytes,
		staticTokens,
		exchangeBytes,
		exchangeTokens,
		postSkillBytes,
		postSkillTokens,
		twoRequestBytes: staticBytes + postSkillBytes,
		twoRequestTokens: staticTokens + postSkillTokens,
	};
}

async function compareWorkflow(
	label,
	catalogSkills,
	selected,
	prompt,
	harness,
	toolSchema,
) {
	const stockPrompt = formatSkillsForPrompt(catalogSkills);
	await harness.before({
		type: "before_agent_start",
		prompt,
		systemPrompt: stockPrompt,
		systemPromptOptions: {
			cwd: dirname(selected.filePath),
			skills: catalogSkills,
			selectedTools: ["skill"],
		},
	});
	const currentToolResult = await harness.tool.execute("benchmark", {
		name: selected.name,
	});
	const currentResult = resultText(currentToolResult);
	const currentContext = resultContext(currentToolResult);
	const full015Result = [
		currentToolResult.content[0]?.text ?? "",
		JSON.stringify({ skill: selected.name, ...currentContext }),
	].join("\n");
	const legacy = await legacyResult(selected);
	const adaptive = adaptiveCatalog(catalogSkills, prompt);
	const args = JSON.stringify({ name: selected.name });
	return {
		label,
		selection: adaptive.selection,
		rows: [
			variant("0.1.1", legacyCatalog(catalogSkills), legacyToolSchema, args, legacy),
			variant(
				"0.1.5 full",
				renderCompactCatalog(catalogSkills, {
					descriptionMax: DEFAULT_DESCRIPTION_MAX,
				}),
				full015ToolSchema,
				args,
				full015Result,
			),
			variant(
				"0.1.6 adaptive",
				adaptive.catalog,
				toolSchema,
				args,
				currentResult,
			),
		],
	};
}

function localSkills() {
	const roots = [
		join(homedir(), ".agents/skills"),
		join(
			homedir(),
			".pi/agent/npm/node_modules/pi-mcp-adapter/skills",
		),
		join(homedir(), ".pi/agent/npm/node_modules/pi-subagents/skills"),
		join(homedir(), ".pi/agent/npm/node_modules/pi-lens/skills"),
	];
	const byName = new Map();
	for (const root of roots) {
		if (!existsSync(root)) continue;
		for (const skill of loadSkillsFromDir({ dir: root, source: "local" }).skills) {
			if (!skill.disableModelInvocation && !byName.has(skill.name)) {
				byName.set(skill.name, skill);
			}
		}
	}
	return [...byName.values()];
}

const harness = createToolHarness();
const toolSchema = serializeToolDefinition(harness.tool);
const fixtureComparison = await compareWorkflow(
	`fixtures (${skills.length}) / alpha`,
	skills,
	selectedSkill,
	"Use the alpha skill for this task.",
	harness,
	toolSchema,
);
const realWorldSkill = realWorldSkills[0];
const realWorldComparison = realWorldSkill
	? await compareWorkflow(
			`real-world (${realWorldSkills.length}) / ${realWorldSkill.name}`,
			realWorldSkills,
			realWorldSkill,
			`Use ${realWorldSkill.name} to handle this production incident.`,
			harness,
			toolSchema,
		)
	: undefined;
const installedSkills = localSkills();
const ponytail = installedSkills.find((skill) => skill.name === "ponytail");
const localComparison = ponytail
	? await compareWorkflow(
			`local (${installedSkills.length}) / ponytail`,
			installedSkills,
			ponytail,
			"Try to load the ponytail skill please.",
			harness,
			toolSchema,
		)
	: undefined;
const comparisons = [
	fixtureComparison,
	...(realWorldComparison ? [realWorldComparison] : []),
	...(localComparison ? [localComparison] : []),
];
for (const comparison of comparisons) {
	const legacy = comparison.rows.find((row) => row.label === "0.1.1");
	const adaptive = comparison.rows.find(
		(row) => row.label === "0.1.6 adaptive",
	);
	if (!legacy || !adaptive) throw new Error("Benchmark comparison row is missing.");
	if (comparison.selection.fallback) {
		throw new Error(`${comparison.label} unexpectedly used full fallback.`);
	}
	if (adaptive.twoRequestTokens > legacy.twoRequestTokens) {
		throw new Error(
			`${comparison.label} adaptive cumulative tokens exceed 0.1.1.`,
		);
	}
}
if (
	localComparison &&
	(localComparison.rows.find((row) => row.label === "0.1.6 adaptive")
		?.postSkillTokens ?? Number.POSITIVE_INFINITY) > 3_286
) {
	throw new Error("Local Ponytail post-skill context exceeds 3,286 tokens.");
}

const scaleRows = [1, 2, 5, 10, 20, 50, 100, 500, 1000].map((count) => {
	const catalogSkills = syntheticSkills(count);
	const adaptive = adaptiveCatalog(
		catalogSkills,
		"Run workflow-0 with skill-000 and verify its evidence.",
	);
	return {
		count,
		stock: tokens(formatSkillsForPrompt(catalogSkills)),
		legacy: tokens(legacyCatalog(catalogSkills)) + tokens(legacyToolSchema),
		full:
			tokens(
				renderCompactCatalog(catalogSkills, {
					descriptionMax: DEFAULT_DESCRIPTION_MAX,
				}),
			) + tokens(full015ToolSchema),
		adaptive: tokens(adaptive.catalog) + tokens(toolSchema),
		selected: adaptive.selection.describedSkills.length,
		fallback: adaptive.selection.fallback,
	};
});

const rawRead = await measure(async () => {
	const content = await readFile(selectedSkill.filePath, "utf8");
	parseFrontmatter(content).body.trim();
});
const defaultLoad = await measure(() =>
	loadSkill(selectedSkill, DEFAULT_FILE_LIMIT),
);
const sampledLoad = await measure(() => loadSkill(selectedSkill, 10));
const routing22 = installedSkills.length > 0
	? await measure(() => {
			selectRoutingSkills(
				buildRoutingIndex(installedSkills),
				buildRoutingQuery("Try to load the ponytail skill please."),
			);
		})
	: undefined;
const routing1000Skills = syntheticSkills(1000);
const routing1000Index = buildRoutingIndex(routing1000Skills);
const routing1000 = await measure(() => {
	selectRoutingSkills(
		routing1000Index,
		buildRoutingQuery("Run workflow-0 with skill-000."),
	);
});
await harness.before({
	type: "before_agent_start",
	prompt: "Use alpha.",
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
const nativeReadTool = createReadToolDefinition(fixtureRoot);
const nativeReadResult = await nativeReadTool.execute("benchmark", {
	path: selectedSkill.filePath,
});

const lines = [
	`Recorded performance baseline: ${RECORDED_PERFORMANCE_BASELINE.gitHead} (${RECORDED_PERFORMANCE_BASELINE.performanceRating}/10)`,
	`Schemas: 0.1.1 ${bytes(legacyToolSchema)} B / ${tokens(legacyToolSchema)} tok; 0.1.5 ${bytes(full015ToolSchema)} B / ${tokens(full015ToolSchema)} tok; 0.1.6 ${bytes(toolSchema)} B / ${tokens(toolSchema)} tok`,
	"",
	"Workflow component sums (extension-attributable; same two-request shape):",
];
for (const comparison of comparisons) {
	lines.push(
		`  ${comparison.label}`,
		`    selected: ${comparison.selection.describedSkills.map((skill) => skill.name).join(", ") || "full fallback"}; remaining names ${comparison.selection.remainingNames.length}; reason ${comparison.selection.reason}`,
	);
	for (const row of comparison.rows) {
		lines.push(
			`    ${row.label.padEnd(14)} static ${String(row.staticTokens).padStart(5)} tok | exchange ${String(row.exchangeTokens).padStart(5)} | post-skill ${String(row.postSkillTokens).padStart(5)} | two-request component sum ${String(row.twoRequestTokens).padStart(5)} tok`,
		);
	}
}
lines.push(
	"",
	"Static scale (catalog + schema tokens):",
	...scaleRows.map(
		(row) =>
			`  ${String(row.count).padStart(4)} skills  stock ${String(row.stock).padStart(6)} | 0.1.1 ${String(row.legacy).padStart(6)} | 0.1.5 ${String(row.full).padStart(6)} | 0.1.6 ${String(row.adaptive).padStart(6)} (${row.selected} described${row.fallback ? ", fallback" : ""})`,
	),
	"",
	`Warm operations (${MEASURED_ITERATIONS} iterations, milliseconds):`,
	`  raw read + parse       p50 ${rawRead.p50}  p95 ${rawRead.p95}`,
	`  default load           p50 ${defaultLoad.p50}  p95 ${defaultLoad.p95}`,
	`  sampled load           p50 ${sampledLoad.p50}  p95 ${sampledLoad.p95}`,
	`  full skill tool        p50 ${fullToolLoad.p50}  p95 ${fullToolLoad.p95}`,
	...(routing22
		? [`  local routing (${installedSkills.length})    p50 ${routing22.p50}  p95 ${routing22.p95}`]
		: []),
	`  routing (1000)         p50 ${routing1000.p50}  p95 ${routing1000.p95}`,
	`  recorded old load      p50 ${RECORDED_PERFORMANCE_BASELINE.defaultLoadP50Ms.toFixed(3)}  p95 ${RECORDED_PERFORMANCE_BASELINE.defaultLoadP95Ms.toFixed(3)}`,
	"",
	`Native read result diagnostic: ${bytes(resultText(nativeReadResult))} B / ${tokens(resultText(nativeReadResult))} tokens`,
	"Token values use Pi estimateTokens independently per component; sums are not complete provider request estimates.",
	"Common context is excluded only where explicitly labeled extension-attributable.",
	"Local skill measurement is optional and appears only when installed skill roots exist.",
	"Fallback cases preserve the complete 0.1.5 catalog and are not claimed to beat 0.1.1.",
	"Timing is machine-specific; compare runs on the same workstation.",
	"",
);
process.stdout.write(lines.join("\n"));
