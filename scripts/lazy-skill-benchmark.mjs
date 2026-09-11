import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { basename, dirname, relative, resolve } from "node:path";
import {
	estimateTokens,
	formatSkillsForPrompt,
	loadSkillsFromDir,
	parseFrontmatter,
	truncateHead,
} from "../packages/lazy-skill-tool/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import lazySkillTool from "../packages/lazy-skill-tool/src/index.ts";
import {
	normalizeDescription,
	renderSafeCatalog,
	STABLE_ADAPTIVE_INSTRUCTIONS,
} from "../packages/lazy-skill-tool/src/catalog.ts";
import {
	DEFAULT_CATALOG_TOKEN_BUDGET,
	readConfig,
} from "../packages/lazy-skill-tool/src/config.ts";
import { sampleRelatedFiles } from "../packages/lazy-skill-tool/src/files.ts";
import { loadSkill } from "../packages/lazy-skill-tool/src/loader.ts";
import { renderDisclosureCatalog } from "../packages/lazy-skill-tool/src/prompt.ts";
import {
	buildRoutingIndex,
	buildRoutingQuery,
	discloseAdaptiveCatalog,
	selectRoutingSkills,
} from "../packages/lazy-skill-tool/src/routing.ts";
import { buildSkillSnapshot } from "../packages/lazy-skill-tool/src/snapshot.ts";
import { compileSkillPolicy } from "../packages/lazy-skill-tool/src/policy.ts";

const SCALE_COUNTS = [1, 5, 10, 25, 50, 100];
const WARMUP_ITERATIONS = 100;
const MEASURED_ITERATIONS = 500;
const fixtureRoot = resolve("test/fixtures/lazy-skills");
const realWorldRoot = resolve("test/fixtures/lazy-real-world");
const fixtureSkills = loadSkillsFromDir({
	dir: fixtureRoot,
	source: "benchmark",
}).skills;
const realWorldSkills = loadSkillsFromDir({
	dir: realWorldRoot,
	source: "benchmark",
}).skills;
const selectedSkill = fixtureSkills.find((skill) => skill.name === "alpha");
if (!selectedSkill)
	throw new Error("Benchmark fixture skill alpha is missing.");

function characters(value) {
	return [...value].length;
}

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

function metric(value) {
	return {
		characters: characters(value),
		bytes: bytes(value),
		tokens: tokens(value),
	};
}

function reduction(smaller, larger) {
	return ((1 - smaller / larger) * 100).toFixed(1);
}

function escapeXml(value) {
	return value
		.replace(/&/gu, "&amp;")
		.replace(/</gu, "&lt;")
		.replace(/>/gu, "&gt;")
		.replace(/"/gu, "&quot;")
		.replace(/'/gu, "&apos;");
}

function exactNameAttribute(name) {
	return escapeXml(JSON.stringify(name).slice(1, -1));
}

function sortedVisible(skills) {
	return skills
		.filter((skill) => !skill.disableModelInvocation)
		.toSorted((left, right) => left.name.localeCompare(right.name));
}

// Frozen v0.1.6 serialization. This standalone benchmark query exercises
// scoring behavior that is unchanged from v0.1.6.
function render016Entries(skills) {
	return sortedVisible(skills).map(
		(skill) =>
			`<skill name="${exactNameAttribute(skill.name)}">${escapeXml(normalizeDescription(skill.description))}</skill>`,
	);
}

function render016Full(skills) {
	return [
		"Call `skill` by exact name (JSON escapes); resolve paths from returned base.",
		"<skills>",
		...render016Entries(skills),
		"</skills>",
	].join("\n");
}

function render016Adaptive(describedSkills, remainingNames) {
	if (remainingNames.length === 0) return render016Full(describedSkills);
	return [
		"Call `skill` by exact name; candidate descriptions are complete. Other exact names remain loadable.",
		"<skills>",
		...render016Entries(describedSkills),
		"</skills>",
		`<other_skill_names>${escapeXml(JSON.stringify(remainingNames.toSorted()))}</other_skill_names>`,
	].join("\n");
}

function openCodeVerboseCatalog(skills) {
	return [
		"<available_skills>",
		...sortedVisible(skills).flatMap((skill) => [
			"  <skill>",
			`    <name>${escapeXml(skill.name)}</name>`,
			`    <description>${escapeXml(normalizeDescription(skill.description))}</description>`,
			`    <location>${escapeXml(skill.filePath)}</location>`,
			"  </skill>",
		]),
		"</available_skills>",
	].join("\n");
}

function syntheticSkills(count) {
	return Array.from({ length: count }, (_, index) => {
		const name = `skill-${String(index).padStart(3, "0")}`;
		const filePath = resolve(`/tmp/lazy-skill-benchmark/${name}/SKILL.md`);
		return {
			name,
			description: `Use this skill for focused workflow ${index}, validation, and related project tasks. Trigger on workflow-${index}, exact evidence review, and safe execution.`,
			filePath,
			baseDir: dirname(filePath),
			sourceInfo: {
				path: filePath,
				source: "benchmark",
				scope: "temporary",
				origin: "top-level",
				baseDir: dirname(filePath),
			},
			disableModelInvocation: false,
		};
	});
}

function adaptiveSelection(skills, prompt) {
	return selectRoutingSkills(
		buildRoutingIndex(skills),
		buildRoutingQuery(prompt),
	);
}

function render016AdaptiveFor(skills, prompt) {
	const selection = adaptiveSelection(skills, prompt);
	return {
		selection,
		catalog: selection.fallback
			? render016Full(skills)
			: render016Adaptive(selection.describedSkills, selection.remainingNames),
	};
}

function render030AdaptiveFor(skills, prompt) {
	const safeCatalog = renderSafeCatalog(skills);
	const disclosure = discloseAdaptiveCatalog({
		index: buildRoutingIndex(skills),
		query: buildRoutingQuery(prompt),
		modelVisible: skills,
		safeCatalog,
		safeCatalogTokens: tokens(safeCatalog),
		catalogTokenBudget: DEFAULT_CATALOG_TOKEN_BUDGET,
	});
	return {
		disclosure,
		selection: disclosure.selection,
		catalog: renderDisclosureCatalog(disclosure, {
			maxDescriptionCharacters: 0,
		}),
	};
}

function captureToolMetadata() {
	const keys = [
		"PI_LAZY_SKILL_DISABLE",
		"PI_LAZY_SKILL_ROUTING",
		"PI_LAZY_SKILL_DESCRIPTION_MAX",
		"PI_LAZY_SKILL_FILE_LIMIT",
	];
	const previous = new Map(keys.map((key) => [key, process.env[key]]));
	for (const key of keys) delete process.env[key];
	const tools = new Map();
	try {
		lazySkillTool({
			registerTool(definition) {
				tools.set(definition.name, definition);
			},
			registerCommand() {},
			on() {},
		});
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
	const tool = tools.get("skill") ?? tools.values().next().value;
	if (!tool) throw new Error("Lazy skill tool metadata was not registered.");
	return { tool, tools };
}

function serializeToolSchema(tool) {
	return JSON.stringify({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	});
}

const TOOL_016_SCHEMA = JSON.stringify({
	name: "skill",
	description: "Load skill; next offset/column continues.",
	parameters: captureToolMetadata().tool.parameters,
});
const captured = captureToolMetadata();
const tool020 = captured.tool;
const TOOL_020_SCHEMA = serializeToolSchema(tool020);
const TOOL_020_SNIPPET = `- skill: ${tool020.promptSnippet}`;
const TOOL_020_GUIDELINE = `- ${tool020.promptGuidelines[0]}`;
const searchTool = captured.tools.get("skill_search");
const TOOL_030_SEARCH_SCHEMA = searchTool ? serializeToolSchema(searchTool) : "";
const TOOL_030_SEARCH_SNIPPET = searchTool
	? `- skill_search: ${searchTool.promptSnippet}`
	: "";
const TOOL_030_SEARCH_GUIDELINE = searchTool
	? `- ${searchTool.promptGuidelines[0]}`
	: "";
const FIXED_020 = [TOOL_020_SCHEMA, TOOL_020_SNIPPET, TOOL_020_GUIDELINE].join(
	"\n",
);
const FIXED_030 = [
	FIXED_020,
	TOOL_030_SEARCH_SCHEMA,
	TOOL_030_SEARCH_SNIPPET,
	TOOL_030_SEARCH_GUIDELINE,
]
	.filter(Boolean)
	.join("\n");

function componentTotal(catalog, fixed) {
	return {
		characters: characters(catalog) + characters(fixed),
		bytes: bytes(catalog) + bytes(fixed),
		tokens: tokens(catalog) + tokens(fixed),
	};
}

async function loadSkill016(skill) {
	const buffer = await readFile(skill.filePath);
	const source = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	const normalized = source.replace(/\r\n?/gu, "\n");
	const closingIndex = normalized.indexOf("\n---", 4);
	const afterClosing = closingIndex + 4;
	if (
		!normalized.startsWith("---\n") ||
		closingIndex === -1 ||
		(afterClosing < normalized.length && normalized[afterClosing] !== "\n")
	) {
		throw new Error("Frozen v0.1.6 fixture frontmatter is invalid.");
	}
	const parsed = parseFrontmatter(source);
	const currentName = parsed.frontmatter.name;
	const canonicalName =
		currentName === undefined || currentName === null || currentName === ""
			? basename(dirname(skill.filePath))
			: currentName;
	if (
		typeof parsed.frontmatter.description !== "string" ||
		parsed.frontmatter.description.trim().length === 0 ||
		typeof canonicalName !== "string" ||
		canonicalName !== skill.name ||
		parsed.frontmatter["disable-model-invocation"] === true ||
		parsed.body.trim().length === 0
	) {
		throw new Error("Frozen v0.1.6 fixture validation failed.");
	}
	const lines = source.split("\n");
	const bodyTruncation = truncateHead(
		[lines[0] ?? "", ...lines.slice(1)].join("\n"),
	);
	const relatedFiles = await sampleRelatedFiles(
		skill.baseDir,
		skill.filePath,
		0,
	);
	return {
		body: bodyTruncation.content,
		bodyOffset: 1,
		bodyColumn: 1,
		bodyTruncation,
		relatedFiles,
	};
}

// Paired samples isolate loader deltas from the allocation-heavy synthetic runs.
const pairedLazyTiming = await measurePair(
	() => loadSkill016(selectedSkill),
	() => loadSkill(selectedSkill, 0),
);
const lazy016Invocation = pairedLazyTiming.left;
const lazyInvocation = pairedLazyTiming.right;

const scaleRows = SCALE_COUNTS.map((count) => {
	const skills = syntheticSkills(count);
	const prompt = "Run workflow-0 with skill-000 and verify its evidence.";
	const stock = formatSkillsForPrompt(skills, "read");
	const openCode = openCodeVerboseCatalog(skills);
	const oldAdaptive = render016AdaptiveFor(skills, prompt);
	const oldFull = render016Full(skills);
	const safe = renderSafeCatalog(skills);
	const adaptive = render030AdaptiveFor(skills, prompt);
	const safeTokens = tokens(safe);
	for (const skill of skills) {
		const complete = escapeXml(normalizeDescription(skill.description));
		if (!safe.includes(complete)) {
			throw new Error(
				`Safe catalog omitted a complete description at ${count} skills.`,
			);
		}
	}
	if (bytes(safe) >= bytes(stock) || safeTokens >= tokens(stock)) {
		throw new Error(`Safe catalog did not beat stock Pi at ${count} skills.`);
	}
	if (bytes(safe) >= bytes(openCode) || safeTokens >= tokens(openCode)) {
		throw new Error(
			`Safe catalog did not beat verbose OpenCode style at ${count} skills.`,
		);
	}
	if (bytes(safe) > bytes(oldFull) || safeTokens > tokens(oldFull)) {
		throw new Error(
			`Safe catalog regressed from v0.1.6 full at ${count} skills.`,
		);
	}
	if (safeTokens <= DEFAULT_CATALOG_TOKEN_BUDGET) {
		if (adaptive.disclosure.strategy !== "full-catalog") {
			throw new Error(
				`v0.3.0 adaptive should expose the inexpensive catalog at ${count} skills.`,
			);
		}
		if (adaptive.catalog !== safe) {
			throw new Error(
				`v0.3.0 inexpensive adaptive catalog diverged from safe at ${count} skills.`,
			);
		}
	} else if (tokens(adaptive.catalog) >= safeTokens) {
		throw new Error(
			`v0.3.0 adaptive catalog was not smaller than safe at ${count} skills.`,
		);
	}
	const adaptivePrompt = [STABLE_ADAPTIVE_INSTRUCTIONS, adaptive.catalog]
		.filter(Boolean)
		.join("\n");
	return {
		count,
		stock: metric(stock),
		openCode: metric(openCode),
		oldFull: metric(oldFull),
		oldFullTotal: componentTotal(oldFull, TOOL_016_SCHEMA),
		oldAdaptive: metric(oldAdaptive.catalog),
		oldAdaptiveTotal: componentTotal(oldAdaptive.catalog, TOOL_016_SCHEMA),
		safe: metric(safe),
		safeSkillOnlyTotal: componentTotal(safe, FIXED_020),
		safeTotal: componentTotal(safe, FIXED_030),
		adaptive: metric(adaptive.catalog),
		adaptiveTotal: componentTotal(adaptivePrompt, FIXED_030),
		strategy: adaptive.disclosure.strategy,
		selected: adaptive.disclosure.describedSkills.length,
	};
});

const skillOnlyBreakEven = scaleRows.find(
	(row) => row.safeSkillOnlyTotal.tokens < row.stock.tokens,
)?.count;
const breakEven = scaleRows.find(
	(row) => row.safeTotal.tokens < row.stock.tokens,
)?.count;
if (skillOnlyBreakEven === undefined) {
	throw new Error(
		"Safe skill-only total context never reached stock Pi break-even.",
	);
}
if (skillOnlyBreakEven > 5) {
	throw new Error(
		`Safe skill-only total break-even was ${skillOnlyBreakEven}, above the target of five skills.`,
	);
}
if (breakEven === undefined) {
	throw new Error("v0.3.0 safe total context never reached stock Pi break-even.");
}
if (breakEven > 10) {
	throw new Error(
		`v0.3.0 safe total break-even was ${breakEven}, above the target of ten skills with skill_search.`,
	);
}
for (const row of scaleRows) {
	if (row.strategy === "full-catalog") continue;
	if (row.adaptiveTotal.tokens >= row.safeTotal.tokens) {
		throw new Error(
			`v0.3.0 adaptive total was not below safe at ${row.count} skills.`,
		);
	}
}

function percentile(sorted, fraction) {
	return sorted[
		Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
	];
}

function timingSummary(samples) {
	samples.sort((left, right) => left - right);
	return {
		p50: percentile(samples, 0.5).toFixed(3),
		p95: percentile(samples, 0.95).toFixed(3),
	};
}

async function measure(operation) {
	for (let index = 0; index < WARMUP_ITERATIONS; index += 1) await operation();
	const samples = [];
	for (let index = 0; index < MEASURED_ITERATIONS; index += 1) {
		const started = performance.now();
		await operation();
		samples.push(performance.now() - started);
	}
	return timingSummary(samples);
}

async function measurePair(leftOperation, rightOperation) {
	for (let index = 0; index < WARMUP_ITERATIONS; index += 1) {
		await leftOperation();
		await rightOperation();
	}
	const leftSamples = [];
	const rightSamples = [];
	async function sample(operation, samples) {
		const started = performance.now();
		await operation();
		samples.push(performance.now() - started);
	}
	for (let index = 0; index < MEASURED_ITERATIONS; index += 1) {
		if (index % 2 === 0) {
			await sample(leftOperation, leftSamples);
			await sample(rightOperation, rightSamples);
		} else {
			await sample(rightOperation, rightSamples);
			await sample(leftOperation, leftSamples);
		}
	}
	return {
		left: timingSummary(leftSamples),
		right: timingSummary(rightSamples),
	};
}

const config = readConfig({}).config;
const policy = compileSkillPolicy();
const startupSkills = syntheticSkills(100);
const safeStartup = await measure(() =>
	buildSkillSnapshot(startupSkills, config, policy),
);
const adaptiveStartup = await measure(() =>
	buildSkillSnapshot(startupSkills, { ...config, routing: "adaptive" }, policy),
);
const routingIndex = buildRoutingIndex(startupSkills);
const adaptiveRouting = await measure(() =>
	selectRoutingSkills(
		routingIndex,
		buildRoutingQuery("Run workflow-0 with skill-000."),
	),
);

async function loadedPayloadRow(skill) {
	const source = await readFile(skill.filePath, "utf8");
	const oldPayload = [
		source,
		JSON.stringify({
			base: skill.baseDir,
			fileFromBase: relative(skill.baseDir, skill.filePath),
		}),
	].join("\n");
	const loaded = await loadSkill(skill, 0);
	const newPayload = [loaded.body, JSON.stringify({ base: skill.baseDir })].join(
		"\n",
	);
	if (loaded.body !== parseFrontmatter(source).body) {
		throw new Error(`Loaded body mismatch for ${skill.name}.`);
	}
	if (
		bytes(newPayload) > bytes(oldPayload) ||
		tokens(newPayload) > tokens(oldPayload)
	) {
		throw new Error(`Loaded payload regressed from v0.1.6 for ${skill.name}.`);
	}
	return {
		name: skill.name,
		old: metric(oldPayload),
		current: metric(newPayload),
	};
}

const payloadRows = [];
for (const skill of [selectedSkill, ...realWorldSkills.slice(0, 1)]) {
	payloadRows.push(await loadedPayloadRow(skill));
}

const fixedRows = [
	["v0.1.6 tool schema", TOOL_016_SCHEMA],
	["v0.3.0 skill schema", TOOL_020_SCHEMA],
	["v0.3.0 skill snippet", TOOL_020_SNIPPET],
	["v0.3.0 skill guideline", TOOL_020_GUIDELINE],
	["v0.3.0 search schema", TOOL_030_SEARCH_SCHEMA],
	["v0.3.0 search snippet", TOOL_030_SEARCH_SNIPPET],
	["v0.3.0 search guideline", TOOL_030_SEARCH_GUIDELINE],
	["v0.3.0 stable adaptive", STABLE_ADAPTIVE_INSTRUCTIONS],
];
const lines = [
	"Lazy skill context benchmark (Pi estimateTokens; component token estimates are summed)",
	"",
	"Fixed extension context:",
	...fixedRows.map(([label, value]) => {
		const measured = metric(value);
		return `  ${label.padEnd(24)} ${String(measured.bytes).padStart(5)} B  ${String(measured.tokens).padStart(4)} tok`;
	}),
	`  ${"v0.3.0 fixed total".padEnd(24)} ${String(bytes(FIXED_030)).padStart(5)} B  ${String(tokens(FIXED_030)).padStart(4)} tok`,
	"",
	"Catalog / total context by representative corpus:",
	"  count | stock Pi | OpenCode verbose | 0.1.6 full | 0.1.6 adaptive | 0.3.0 safe | 0.3.0 adaptive",
	...scaleRows.map(
		(row) =>
			`  ${String(row.count).padStart(5)} | ${String(row.stock.tokens).padStart(5)} tok | ${String(row.openCode.tokens).padStart(5)} tok | ${String(row.oldFull.tokens).padStart(5)}/${String(row.oldFullTotal.tokens).padStart(5)} | ${String(row.oldAdaptive.tokens).padStart(5)}/${String(row.oldAdaptiveTotal.tokens).padStart(5)} | ${String(row.safe.tokens).padStart(5)}/${String(row.safeTotal.tokens).padStart(5)} | ${String(row.adaptive.tokens).padStart(5)}/${String(row.adaptiveTotal.tokens).padStart(5)} (${row.strategy}, ${row.selected} described)`,
	),
	"  Version columns are catalog/total tokens; stock and OpenCode have no lazy-tool fixed cost.",
	`  Safe skill-only total (without skill_search) first beats stock Pi at ${skillOnlyBreakEven} representative skill(s).`,
	`  v0.3.0 safe total including skill_search first beats stock Pi at ${breakEven} representative skill(s).`,
	"  Adaptive totals include stable system instructions, the task-local catalog, and both tool schemas.",
	"",
	"Exact serialized catalog characters / UTF-8 bytes:",
	...scaleRows.map(
		(row) =>
			`  ${String(row.count).padStart(5)} skills  stock ${String(row.stock.characters).padStart(6)}/${String(row.stock.bytes).padStart(6)}  OpenCode ${String(row.openCode.characters).padStart(6)}/${String(row.openCode.bytes).padStart(6)}  0.1.6-full ${String(row.oldFull.characters).padStart(6)}/${String(row.oldFull.bytes).padStart(6)}  0.1.6-adaptive ${String(row.oldAdaptive.characters).padStart(6)}/${String(row.oldAdaptive.bytes).padStart(6)}  0.3.0-safe ${String(row.safe.characters).padStart(6)}/${String(row.safe.bytes).padStart(6)}  0.3.0-adaptive ${String(row.adaptive.characters).padStart(6)}/${String(row.adaptive.bytes).padStart(6)}`,
	),
	"",
	"v0.3.0 safe catalog reduction versus stock Pi:",
	...scaleRows.map(
		(row) =>
			`  ${String(row.count).padStart(5)} skills  characters ${reduction(row.safe.characters, row.stock.characters).padStart(5)}%  bytes ${reduction(row.safe.bytes, row.stock.bytes).padStart(5)}%  tokens ${reduction(row.safe.tokens, row.stock.tokens).padStart(5)}%`,
	),
	"",
	"Loaded model-facing payload (frontmatter and redundant metadata removal):",
	...payloadRows.map(
		(row) =>
			`  ${row.name}: 0.1.6 ${row.old.characters} chars/${row.old.bytes} B/${row.old.tokens} tok -> 0.3.0 ${row.current.characters} chars/${row.current.bytes} B/${row.current.tokens} tok`,
	),
	"",
	`Warm timings (${MEASURED_ITERATIONS} iterations, milliseconds; machine-specific):`,
	`  safe snapshot (100)     p50 ${safeStartup.p50}  p95 ${safeStartup.p95}`,
	`  adaptive snapshot (100) p50 ${adaptiveStartup.p50}  p95 ${adaptiveStartup.p95}`,
	`  adaptive route (100)    p50 ${adaptiveRouting.p50}  p95 ${adaptiveRouting.p95}`,
	`  frozen v0.1.6 load     p50 ${lazy016Invocation.p50}  p95 ${lazy016Invocation.p95}`,
	`  v0.3.0 lazy invocation  p50 ${lazyInvocation.p50}  p95 ${lazyInvocation.p95}`,
	"",
	"Gates: safe catalog beats stock, verbose, and frozen v0.1.6 full catalogs at every count; inexpensive catalogs expand to safe; large-catalog adaptive totals stay below safe; loaded payloads do not exceed frozen v0.1.6 counterparts.",
	"Catalog visibility safety is structural. This benchmark does not measure live-model skill-selection accuracy or provider billing.",
	"Timing values are not cross-machine performance guarantees.",
	"",
];
process.stdout.write(lines.join("\n"));
