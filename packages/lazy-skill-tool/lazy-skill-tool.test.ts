import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, test } from "node:test";
import {
	formatSkillsForPrompt,
	loadSkillsFromDir,
} from "@earendil-works/pi-coding-agent";
import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	Skill,
} from "@earendil-works/pi-coding-agent";
import lazySkillTool from "./src/index.ts";
import {
	buildRegistry,
	compactDescription,
	escapeXml,
	DEFAULT_DESCRIPTION_MAX,
	DEFAULT_FILE_LIMIT,
	readConfig,
	renderCompactCatalog,
	visibleSkills,
	type RuntimeSkill,
} from "./src/catalog.ts";
import { sampleRelatedFiles } from "./src/files.ts";
import { loadSkill, MAX_SKILL_BYTES } from "./src/loader.ts";
import { appendSkillCatalog, transformSkillPrompt } from "./src/prompt.ts";

const FIXTURE_ROOT = resolve("test/fixtures/lazy-skills");
const CONFIG = {
	descriptionMax: DEFAULT_DESCRIPTION_MAX,
	fileLimit: DEFAULT_FILE_LIMIT,
	disabled: false,
} as const;

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

function makeSkill(
	name: string,
	description: string,
	filePath = join(FIXTURE_ROOT, name, "SKILL.md"),
	baseDir = dirname(filePath),
	disableModelInvocation = false,
): Skill {
	return {
		name,
		description,
		filePath,
		baseDir,
		sourceInfo: {
			path: filePath,
			source: "test",
			scope: "temporary",
			origin: "top-level",
		},
		disableModelInvocation,
	};
}

function promptOptions(
	skills: Skill[],
	selectedTools?: string[],
): BeforeEvent["systemPromptOptions"] {
	return {
		cwd: FIXTURE_ROOT,
		skills,
		...(selectedTools === undefined ? {} : { selectedTools }),
	};
}

function nativePrompt(skillNames: string[] = ["native"]): string {
	const entries = skillNames.flatMap((name) => [
		"  <skill>",
		`    <name>${escapeXml(name)}</name>`,
		`    <description>${escapeXml(name)} catalog entry</description>`,
		`    <location>/private/${escapeXml(name)}/SKILL.md</location>`,
		"  </skill>",
	]);
	return [
		"Keep this unrelated XML: <before><value>1</value></before>.",
		"",
		"The following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory.",
		"",
		"<available_skills>",
		...entries,
		"</available_skills>",
		"",
		"Keep this unrelated XML: <after><value>2</value></after>.",
	].join("\n");
}

test("catalog builds a fresh deterministic registry", () => {
	const first = makeSkill("zeta", "zeta");
	const duplicate = makeSkill("alpha", "duplicate");
	const registry = buildRegistry([
		makeSkill("zeta", " zeta\n description "),
		makeSkill("alpha", "alpha description"),
		makeSkill("hidden", "hidden description", undefined, undefined, true),
		duplicate,
	]);

	assert.deepEqual([...registry.keys()], ["zeta", "alpha", "hidden"]);
	assert.equal(registry.get("alpha")?.description, "alpha description");
	assert.deepEqual(
		visibleSkills(registry).map((skill) => skill.name),
		["alpha", "zeta"],
	);
	assert.notEqual(registry.get("zeta"), first);
});

test("catalog config validates bounds and supports no truncation", () => {
	const result = readConfig({
		PI_LAZY_SKILL_DESCRIPTION_MAX: "0",
		PI_LAZY_SKILL_FILE_LIMIT: "50",
		PI_LAZY_SKILL_DISABLE: "yes",
	});
	assert.deepEqual(result.warnings, []);
	assert.deepEqual(result.config, {
		descriptionMax: 0,
		fileLimit: 50,
		disabled: true,
	});

	const invalid = readConfig({
		PI_LAZY_SKILL_DESCRIPTION_MAX: "-1",
		PI_LAZY_SKILL_FILE_LIMIT: "not-an-int",
	});
	assert.equal(invalid.config.descriptionMax, DEFAULT_DESCRIPTION_MAX);
	assert.equal(invalid.config.fileLimit, DEFAULT_FILE_LIMIT);
	assert.equal(invalid.warnings.length, 2);
});

test("catalog descriptions normalize whitespace, preserve short text, and truncate at words", () => {
	assert.equal(
		compactDescription("  short\n description  ", 240),
		"short description",
	);
	const long = compactDescription(
		"one two three four five six seven eight nine ten",
		20,
	);
	assert.ok(long.endsWith("…"));
	assert.ok(long.length <= 20);
	assert.ok(!long.endsWith(" "));
	assert.equal(
		compactDescription("😀 skill description", 0),
		"😀 skill description",
	);
	assert.equal(compactDescription("123456789😀 trigger", 11), "123456789😀…");
});

test("compact catalog is sorted, escaped, and hides disabled skills", () => {
	const catalog = renderCompactCatalog(
		[
			makeSkill("zeta", "Zeta & details"),
			makeSkill("alpha", "Alpha <details>"),
			makeSkill("a&b", "Unicode 😀 & details"),
			makeSkill("hidden", "Do not show", undefined, undefined, true),
		],
		CONFIG,
	);

	assert.ok(
		catalog.indexOf("<name>alpha</name>") <
			catalog.indexOf("<name>zeta</name>"),
	);
	assert.ok(catalog.includes("Alpha &lt;details&gt;"));
	assert.ok(catalog.includes("Zeta &amp; details"));
	assert.ok(catalog.includes("<name>a&amp;b</name>"));
	assert.ok(!catalog.includes("hidden"));
	assert.ok(!catalog.includes("/test/fixtures"));
});

test("prompt transformation replaces only the bounded native skill section", () => {
	const alpha = makeSkill("alpha", "Alpha description");
	const result = transformSkillPrompt(nativePrompt(["alpha"]), [alpha], CONFIG);

	assert.equal(result.replaced, true);
	assert.equal(result.warning, undefined);
	assert.ok(result.prompt.includes("<before><value>1</value></before>"));
	assert.ok(result.prompt.includes("<after><value>2</value></after>"));
	assert.ok(result.prompt.includes("<name>alpha</name>"));
	assert.ok(!result.prompt.includes("/private/native/SKILL.md"));
	assert.ok(!result.prompt.includes("# Alpha"));
	assert.ok(!result.prompt.includes("Use the read tool"));
	assert.ok(result.prompt.includes("use the `skill` tool"));
	assert.equal(
		transformSkillPrompt(result.prompt, [alpha], CONFIG).prompt,
		result.prompt,
	);
});

test("prompt transformation selects the canonical block when unrelated XML uses the same tag", () => {
	const alpha = makeSkill("alpha", "Alpha description");
	const prompt = [
		"<available_skills><skill><name>example</name></skill></available_skills>",
		"",
		nativePrompt(["alpha"]),
	].join("\n");
	const result = transformSkillPrompt(prompt, [alpha], CONFIG);

	assert.equal(result.warning, undefined);
	assert.ok(result.prompt.includes("<name>example</name>"));
	assert.ok(result.prompt.includes("<name>alpha</name>"));
	assert.ok(!result.prompt.includes("/private/native/SKILL.md"));
});

test("prompt transformation recognizes changed wording and leaves empty catalogs alone", () => {
	const changed = nativePrompt(["alpha"]).replace(
		"Use the read tool to load a skill's file when the task matches its description.",
		"Read the matching skill instructions before continuing.",
	);
	const transformed = transformSkillPrompt(
		changed,
		[makeSkill("alpha", "alpha")],
		CONFIG,
	);
	assert.equal(transformed.replaced, true);
	assert.ok(
		!transformed.prompt.includes("Read the matching skill instructions"),
	);

	const empty = transformSkillPrompt(nativePrompt([]), [], CONFIG);
	assert.equal(empty.replaced, false);
	assert.equal(empty.prompt, nativePrompt([]));

	const unrelated = transformSkillPrompt(
		"<available_skills><skill><name>alpha</name></skill></available_skills>",
		[makeSkill("alpha", "alpha")],
		CONFIG,
	);
	assert.equal(unrelated.replaced, false);
});

test("prompt transformation does not replace a later same-name superset block", () => {
	const alpha = makeSkill("alpha", "Alpha description");
	const prompt = [
		nativePrompt(["alpha"]),
		"",
		"<available_skills><skill><name>alpha</name></skill><skill><name>custom</name></skill></available_skills>",
	].join("\n");
	const result = transformSkillPrompt(prompt, [alpha], CONFIG);

	assert.equal(result.replaced, true);
	assert.ok(result.prompt.includes("<name>custom</name>"));
	assert.ok(!result.prompt.includes("/private/alpha/SKILL.md"));
});

test("skill-only mode appends a compact catalog without replacing unrelated XML", () => {
	const alpha = makeSkill("alpha", "Alpha description");
	const prompt =
		"Base prompt\n<available_skills><custom>keep</custom></available_skills>";
	const result = appendSkillCatalog(prompt, [alpha], CONFIG);

	assert.equal(result.replaced, true);
	assert.ok(result.prompt.startsWith(prompt));
	assert.ok(result.prompt.includes("<custom>keep</custom>"));
	assert.ok(result.prompt.includes("<name>alpha</name>"));
});

test("prompt transformation fails safely when tags are missing or incomplete", () => {
	const unchanged = "<unrelated><available>value</available></unrelated>";
	const missing = transformSkillPrompt(
		unchanged,
		[makeSkill("alpha", "alpha")],
		CONFIG,
	);
	assert.equal(missing.prompt, unchanged);
	assert.equal(missing.replaced, false);
	assert.match(missing.warning ?? "", /available_skills/);

	const incomplete = transformSkillPrompt(
		"before\n<available_skills>\n<skill>",
		[makeSkill("alpha", "alpha")],
		CONFIG,
	);
	assert.equal(incomplete.prompt, "before\n<available_skills>\n<skill>");
	assert.equal(incomplete.replaced, false);

	const customOnly = transformSkillPrompt(
		"<available_skills><skill>custom</skill></available_skills>",
		[],
		CONFIG,
	);
	assert.equal(customOnly.replaced, false);
	assert.equal(customOnly.warning, undefined);
});

test("fixture skill loads body and bounded related files without following symlink directories", async () => {
	const alpha = makeSkill(
		"alpha",
		"Alpha",
		join(FIXTURE_ROOT, "alpha", "SKILL.md"),
		join(FIXTURE_ROOT, "alpha"),
	);
	const loaded = await loadSkill(alpha as unknown as RuntimeSkill, 10);
	assert.ok(loaded.body.includes("# Alpha"));
	assert.ok(!loaded.body.includes("name: alpha"));
	assert.deepEqual(
		loaded.relatedFiles.files.map((file) =>
			relative(join(FIXTURE_ROOT, "alpha"), file),
		),
		["references/NOTES.md", "scripts/alpha.sh"],
	);
	assert.equal(
		loaded.relatedFiles.files.some((file) => file.endsWith("SKILL.md")),
		false,
	);

	const directory = await mkdtemp(join(tmpdir(), "pi-lazy-files-"));
	temporaryDirectories.push(directory);
	await writeFile(
		join(directory, "SKILL.md"),
		"---\nname: temp\ndescription: temp\n---\nbody\n",
	);
	await mkdir(join(directory, "real"));
	await writeFile(join(directory, "real", "one.txt"), "one");
	const exact = await sampleRelatedFiles(
		directory,
		join(directory, "SKILL.md"),
		1,
	);
	assert.equal(exact.truncated, false);
	const missingDirectory = await sampleRelatedFiles(
		join(directory, "missing"),
		join(directory, "missing", "SKILL.md"),
		1,
	);
	assert.equal(missingDirectory.truncated, true);
	await symlink(join(directory, "real"), join(directory, "linked"), "dir");
	const sampled = await sampleRelatedFiles(
		directory,
		join(directory, "SKILL.md"),
		10,
	);
	assert.deepEqual(sampled.files, [join(directory, "real", "one.txt")]);

	const limited = await sampleRelatedFiles(
		FIXTURE_ROOT,
		join(FIXTURE_ROOT, "alpha", "SKILL.md"),
		1,
	);
	assert.equal(limited.files.length, 1);
	assert.equal(limited.truncated, true);

	const hugeDirectory = await mkdtemp(join(tmpdir(), "pi-lazy-many-"));
	temporaryDirectories.push(hugeDirectory);
	const hugePrimary = join(hugeDirectory, "SKILL.md");
	await writeFile(
		hugePrimary,
		"---\nname: huge\ndescription: huge\n---\nbody\n",
	);
	await Promise.all(
		Array.from({ length: 1025 }, (_, index) =>
			writeFile(join(hugeDirectory, `resource-${index}.txt`), String(index)),
		),
	);
	const bounded = await sampleRelatedFiles(hugeDirectory, hugePrimary, 1);
	assert.equal(bounded.files.length, 1);
	assert.equal(bounded.truncated, true);

	const controller = new AbortController();
	const pending = sampleRelatedFiles(
		hugeDirectory,
		hugePrimary,
		1,
		controller.signal,
	);
	setImmediate(() => controller.abort());
	await assert.rejects(
		pending,
		(error: unknown) => error instanceof Error && error.name === "AbortError",
	);
});

test("loader errors are concise and cancellation is preserved", async () => {
	const missing = makeSkill(
		"missing",
		"missing",
		join(FIXTURE_ROOT, "missing", "SKILL.md"),
		FIXTURE_ROOT,
	);
	await assert.rejects(
		loadSkill(missing as unknown as RuntimeSkill, 10),
		/no longer readable/,
	);

	const directory = await mkdtemp(join(tmpdir(), "pi-lazy-invalid-"));
	temporaryDirectories.push(directory);
	const invalidPath = join(directory, "SKILL.md");
	await writeFile(invalidPath, "---\nname: [broken\n---\nbody\n");
	await assert.rejects(
		loadSkill(
			makeSkill(
				"invalid",
				"invalid",
				invalidPath,
				directory,
			) as unknown as RuntimeSkill,
			10,
		),
		/invalid frontmatter/,
	);

	const oversizedPath = join(directory, "oversized.md");
	await writeFile(
		oversizedPath,
		`---\nname: oversized\ndescription: oversized\n---\n${"x".repeat(MAX_SKILL_BYTES)}`,
	);
	await assert.rejects(
		loadSkill(
			makeSkill(
				"oversized",
				"oversized",
				oversizedPath,
				directory,
			) as unknown as RuntimeSkill,
			10,
		),
		/exceeds the .*byte limit/,
	);

	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		loadSkill(
			makeSkill("alpha", "alpha") as unknown as RuntimeSkill,
			10,
			controller.signal,
		),
		(error: unknown) => error instanceof Error && error.name === "AbortError",
	);

	const reason = new Error("custom cancellation");
	const customController = new AbortController();
	customController.abort(reason);
	await assert.rejects(
		loadSkill(
			makeSkill("alpha", "alpha") as unknown as RuntimeSkill,
			10,
			customController.signal,
		),
		(error: unknown) => error === reason,
	);
	await assert.rejects(
		sampleRelatedFiles(
			FIXTURE_ROOT,
			join(FIXTURE_ROOT, "alpha", "SKILL.md"),
			10,
			customController.signal,
		),
		(error: unknown) => error === reason,
	);
});

type BeforeEvent = Pick<
	BeforeAgentStartEvent,
	"systemPrompt" | "systemPromptOptions"
>;
type RegisteredTool = {
	name: string;
	description: string;
	execute: (
		toolCallId: string,
		params: { name: string },
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: ExtensionContext,
	) => Promise<{
		content: Array<{ type: "text"; text: string }>;
		details: Record<string, unknown>;
	}>;
};

type Harness = {
	tool: RegisteredTool;
	registerCount: number;
	before: (event: BeforeEvent) => Promise<unknown>;
};

function createHarness(): Harness {
	const handlers = new Map<
		string,
		(event: BeforeEvent) => Promise<unknown> | unknown
	>();
	let tool: RegisteredTool | undefined;
	let registerCount = 0;
	const pi = {
		registerTool(definition: unknown) {
			registerCount += 1;
			tool = definition as RegisteredTool;
		},
		on(event: string, handler: unknown) {
			handlers.set(
				event,
				handler as (event: BeforeEvent) => Promise<unknown> | unknown,
			);
		},
	};

	lazySkillTool(pi as unknown as ExtensionAPI);
	assert.ok(tool);
	return {
		tool,
		registerCount,
		before: async (event) => handlers.get("before_agent_start")!(event),
	};
}

test("Pi canonical discovery feeds the lazy prompt and tool harness", async () => {
	const discovered = loadSkillsFromDir({ dir: FIXTURE_ROOT, source: "path" });
	assert.deepEqual(discovered.skills.map((skill) => skill.name).sort(), [
		"alpha",
		"beta",
	]);
	assert.deepEqual(discovered.diagnostics, []);

	const stockPrompt = [
		"System instructions before skills.",
		formatSkillsForPrompt(discovered.skills),
		"System instructions after skills.",
	].join("\n\n");
	assert.ok(stockPrompt.includes("/alpha/SKILL.md"));
	assert.ok(stockPrompt.includes("/beta/SKILL.md"));

	const harness = createHarness();
	const result = (await harness.before({
		systemPrompt: stockPrompt,
		systemPromptOptions: promptOptions(discovered.skills),
	})) as { systemPrompt: string };
	assert.ok(result.systemPrompt.includes("<name>alpha</name>"));
	assert.ok(result.systemPrompt.includes("<name>beta</name>"));
	assert.ok(!result.systemPrompt.includes("/alpha/SKILL.md"));
	assert.ok(!result.systemPrompt.includes("# Alpha"));

	const loaded = await harness.tool.execute(
		"call",
		{ name: "alpha" },
		undefined,
		undefined,
		{} as ExtensionContext,
	);
	assert.ok(loaded.content[0]?.text.includes("# Alpha"));
});

test("extension registers one static tool and keeps prompt and registry synchronized", async () => {
	const harness = createHarness();
	assert.equal(harness.registerCount, 1);
	assert.ok(!harness.tool.description.includes("<skill>"));
	assert.ok(!harness.tool.description.includes("alpha"));

	const alpha = makeSkill("alpha", "Alpha description");
	const beta = makeSkill("beta", "Beta description");
	const first = (await harness.before({
		systemPrompt: nativePrompt(["alpha", "beta"]),
		systemPromptOptions: promptOptions([alpha, beta]),
	})) as { systemPrompt: string };
	assert.ok(first.systemPrompt.includes("<name>alpha</name>"));
	assert.ok(first.systemPrompt.includes("<name>beta</name>"));
	assert.ok(!first.systemPrompt.includes(alpha.filePath));

	const loaded = await harness.tool.execute(
		"call",
		{ name: "alpha" },
		undefined,
		undefined,
		{} as ExtensionContext,
	);
	assert.ok(loaded.content[0]?.text.includes("# Alpha"));
	assert.ok(loaded.content[0]?.text.includes("Base directory for this skill"));

	const next = (await harness.before({
		systemPrompt: nativePrompt(["beta"]),
		systemPromptOptions: promptOptions([beta]),
	})) as { systemPrompt: string };
	assert.ok(!next.systemPrompt.includes("<name>alpha</name>"));
	await assert.rejects(
		harness.tool.execute(
			"call",
			{ name: "alpha" },
			undefined,
			undefined,
			{} as ExtensionContext,
		),
		/Skill "alpha" is not available/,
	);

	await harness.before({
		systemPrompt: nativePrompt([]),
		systemPromptOptions: promptOptions([]),
	});
	for (const name of [
		"../../etc/passwd",
		"/etc/passwd",
		"foo/../../bar",
		"",
		"<script>",
	]) {
		await assert.rejects(
			harness.tool.execute(
				"call",
				{ name },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
			/is not available/,
		);
	}
});

test("extension only rewrites prompts when its tool is active", async () => {
	const harness = createHarness();
	const alpha = makeSkill("alpha", "Alpha description");

	const readOnly = await harness.before({
		systemPrompt: nativePrompt(["alpha"]),
		systemPromptOptions: promptOptions([alpha], ["read"]),
	});
	assert.equal(readOnly, undefined);

	const skillOnly = (await harness.before({
		systemPrompt: "Base prompt",
		systemPromptOptions: promptOptions([alpha], ["skill"]),
	})) as { systemPrompt: string };
	assert.ok(skillOnly.systemPrompt.includes("<name>alpha</name>"));
	assert.ok(!skillOnly.systemPrompt.includes(alpha.filePath));

	const inactive = await harness.before({
		systemPrompt: nativePrompt(["alpha"]),
		systemPromptOptions: promptOptions([alpha], ["read", "bash"]),
	});
	assert.equal(inactive, undefined);
});

test("tool output escapes dynamic XML fields", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-lazy-&-"));
	temporaryDirectories.push(directory);
	const filePath = join(directory, "SKILL.md");
	await writeFile(
		filePath,
		"---\nname: a&b\ndescription: special\n---\n# Special\n]]>\n",
	);
	await writeFile(join(directory, "notes.md"), "notes\n");

	const harness = createHarness();
	const skill = makeSkill("a&b", "special", filePath, directory);
	await harness.before({
		systemPrompt: nativePrompt(["a&b"]),
		systemPromptOptions: promptOptions([skill]),
	});
	const result = await harness.tool.execute(
		"call",
		{ name: "a&b" },
		undefined,
		undefined,
		{} as ExtensionContext,
	);
	const text = result.content[0]?.text ?? "";
	assert.ok(text.includes('<skill_content name="a&amp;b">'));
	assert.ok(text.includes("# Skill: a&amp;b"));
	assert.ok(text.includes("]]></skill_body>"));
	assert.ok(text.includes("]]]]><![CDATA[>"));
	assert.ok(
		text.includes(
			`Base directory for this skill: ${directory.replaceAll("&", "&amp;")}`,
		),
	);
	assert.ok(text.includes("notes.md"));
});

test("model-disabled skills remain unavailable to the tool", async () => {
	const harness = createHarness();
	const hidden = makeSkill("hidden", "hidden", undefined, undefined, true);
	const result = await harness.before({
		systemPrompt: nativePrompt([]),
		systemPromptOptions: promptOptions([hidden]),
	});
	assert.equal(result, undefined);
	await assert.rejects(
		harness.tool.execute(
			"call",
			{ name: "hidden" },
			undefined,
			undefined,
			{} as ExtensionContext,
		),
		/is not available/,
	);
});

test("disabled environment leaves native Pi behavior untouched", () => {
	const previous = process.env.PI_LAZY_SKILL_DISABLE;
	process.env.PI_LAZY_SKILL_DISABLE = "1";
	try {
		const handlers = new Map<string, unknown>();
		let registerCount = 0;
		const pi = {
			registerTool() {
				registerCount += 1;
			},
			on(event: string, handler: unknown) {
				handlers.set(event, handler);
			},
		};
		lazySkillTool(pi as unknown as ExtensionAPI);
		assert.equal(registerCount, 0);
		assert.equal(handlers.size, 0);
	} finally {
		if (previous === undefined) delete process.env.PI_LAZY_SKILL_DISABLE;
		else process.env.PI_LAZY_SKILL_DISABLE = previous;
	}
});

test("tool execution captures its registry snapshot", async () => {
	const harness = createHarness();
	const alpha = makeSkill("alpha", "Alpha description");
	const beta = makeSkill("beta", "Beta description");
	await harness.before({
		systemPrompt: nativePrompt(["alpha"]),
		systemPromptOptions: promptOptions([alpha]),
	});
	const pending = harness.tool.execute(
		"call",
		{ name: "alpha" },
		undefined,
		undefined,
		{} as ExtensionContext,
	);
	await harness.before({
		systemPrompt: nativePrompt(["beta"]),
		systemPromptOptions: promptOptions([beta]),
	});
	const result = await pending;
	assert.ok(result.content[0]?.text.includes("# Alpha"));
});
