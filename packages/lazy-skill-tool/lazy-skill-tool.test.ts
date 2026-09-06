import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import {
	formatSkillsForPrompt,
	loadSkillsFromDir,
	parseFrontmatter,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type InputEvent,
	type Skill,
	type SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import lazySkillTool from "./src/index.ts";
import { LazySkillError } from "./src/errors.ts";
import { sampleRelatedFiles } from "./src/files.ts";
import { loadSkill, MAX_SKILL_BYTES, MAX_SKILL_LINES } from "./src/loader.ts";
import {
	appendCanonicalSkillCatalog,
	replaceCanonicalSkillPrompt,
} from "./src/prompt.ts";
import {
	canonicalComparisonPath,
	inspectSkillToolOwnership,
} from "./src/tool-ownership.ts";

const FIXTURE_ROOT = resolve("test/fixtures/lazy-skills");
const REAL_WORLD_FIXTURE_ROOT = resolve("test/fixtures/lazy-real-world");
const OWN_SOURCE = fileURLToPath(new URL("./src/index.ts", import.meta.url));
const ENV_KEYS = [
	"PI_CODING_AGENT_DIR",
	"PI_LAZY_SKILL_ROUTING",
	"PI_LAZY_SKILL_DESCRIPTION_MAX",
	"PI_LAZY_SKILL_MAX_SOURCE_BYTES",
	"PI_LAZY_SKILL_FILE_LIMIT",
	"PI_LAZY_SKILL_DISABLE",
] as const;
const ORIGINAL_ENV = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
const temporaryDirectories: string[] = [];

afterEach(async () => {
	for (const [key, value] of ORIGINAL_ENV) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

function makeSkill(
	name: string,
	description = `${name} complete description`,
	filePath = join(FIXTURE_ROOT, name, "SKILL.md"),
	baseDir = dirname(filePath),
	disableModelInvocation = false,
	source = "test",
	scope: "user" | "project" | "temporary" = "temporary",
): Skill {
	return {
		name,
		description,
		filePath,
		baseDir,
		disableModelInvocation,
		sourceInfo: {
			path: filePath,
			source,
			scope,
			origin: source.startsWith("package:") ? "package" : "top-level",
			baseDir,
		},
	};
}

async function temporarySkill(
	name: string,
	body: string,
	frontmatter = `name: ${name}\ndescription: ${name} description`,
): Promise<Skill> {
	const directory = await mkdtemp(join(tmpdir(), `lazy-${name}-`));
	temporaryDirectories.push(directory);
	const filePath = join(directory, "SKILL.md");
	await writeFile(filePath, `---\n${frontmatter}\n---\n${body}`);
	return makeSkill(name, `${name} description`, filePath, directory);
}

function assertCode(code: string): (error: unknown) => boolean {
	return (error) => error instanceof LazySkillError && error.code === code;
}

test("strict prompt replacement uses Pi's exact formatter and rejects zero or multiple matches", () => {
	const skills = [makeSkill("alpha", "Alpha description")];
	const native = formatSkillsForPrompt(skills, "read");
	const catalog =
		'<available_skills>\n<skill name="alpha">Alpha description</skill>\n</available_skills>';
	const once = replaceCanonicalSkillPrompt(
		`before${native}\nafter`,
		skills,
		catalog,
		"read",
	);
	assert.equal(once.replaced, true);
	assert.equal(once.prompt, `before\n\n${catalog}\nafter`);
	assert.ok(!once.prompt.includes(skills[0]?.filePath ?? "missing"));

	const missing = replaceCanonicalSkillPrompt(
		"unrelated",
		skills,
		catalog,
		"read",
	);
	assert.equal(missing.replaced, false);
	assert.equal(missing.failure, "missing");
	assert.equal(missing.prompt, "unrelated");

	const multiple = replaceCanonicalSkillPrompt(
		`${native}\ncustom${native}`,
		skills,
		catalog,
		"read",
	);
	assert.equal(multiple.replaced, false);
	assert.equal(multiple.failure, "multiple");
	assert.equal(multiple.sanitized, true);
	assert.equal(multiple.prompt, "\ncustom");
});

test("skill-only prompt mode appends once without touching unrelated XML", () => {
	const prompt = "base <available_skills><custom /></available_skills>";
	const catalog =
		'<available_skills>\n<skill name="alpha">Alpha</skill>\n</available_skills>';
	const first = appendCanonicalSkillCatalog(prompt, catalog);
	assert.equal(first.replaced, true);
	assert.ok(first.prompt.startsWith(prompt));
	assert.equal(
		appendCanonicalSkillCatalog(first.prompt, catalog).replaced,
		false,
	);
});

test("loader strips frontmatter and defines offsets against the stripped body", async () => {
	const skill = await temporarySkill(
		"offsets",
		"first 😀 line\nsecond line\nthird line\n",
	);
	const loaded = await loadSkill(skill as never, 0);
	assert.equal(loaded.body, "first 😀 line\nsecond line\nthird line");
	assert.ok(!loaded.body.includes("name: offsets"));
	assert.equal(loaded.bodyOffset, 1);
	assert.equal(loaded.bodyColumn, 1);

	const continued = await loadSkill(skill as never, 0, undefined, 2, 8);
	assert.equal(continued.body, "line\nthird line");
	assert.equal(continued.bodyOffset, 2);
	assert.equal(continued.bodyColumn, 8);
	await assert.rejects(
		loadSkill(skill as never, 0, undefined, 4),
		assertCode("SKILL_OFFSET_INVALID"),
	);
	await assert.rejects(
		loadSkill(skill as never, 0, undefined, 1, 100),
		assertCode("SKILL_OFFSET_INVALID"),
	);
});

test("loader returns stable typed failures without leaking filesystem causes", async () => {
	const missing = makeSkill(
		"missing",
		"missing",
		resolve("does-not-exist", "SKILL.md"),
		resolve("does-not-exist"),
	);
	await assert.rejects(
		loadSkill(missing as never, 0),
		assertCode("SKILL_UNREADABLE"),
	);

	const invalid = await temporarySkill("invalid", "body", "name: [broken");
	await assert.rejects(
		loadSkill(invalid as never, 0),
		assertCode("SKILL_INVALID_FRONTMATTER"),
	);

	const renamed = await temporarySkill(
		"original",
		"body",
		"name: renamed\ndescription: changed",
	);
	await assert.rejects(
		loadSkill(renamed as never, 0),
		assertCode("SKILL_NAME_CHANGED"),
	);

	const empty = await temporarySkill("empty", "   \n");
	await assert.rejects(loadSkill(empty as never, 0), assertCode("SKILL_EMPTY"));

	const disabled = await temporarySkill(
		"disabled",
		"body",
		"name: disabled\ndescription: disabled\ndisable-model-invocation: true",
	);
	await assert.rejects(
		loadSkill(disabled as never, 0),
		assertCode("SKILL_DISABLED_FOR_MODEL"),
	);

	const invalidUtf8 = await temporarySkill("invalid-utf8", "body");
	await writeFile(invalidUtf8.filePath, Buffer.from([0xff, 0xfe, 0xfd]));
	await assert.rejects(
		loadSkill(invalidUtf8 as never, 0),
		assertCode("SKILL_INVALID_UTF8"),
	);

	const oversized = await temporarySkill("oversized", "x".repeat(4096));
	await assert.rejects(
		loadSkill(oversized as never, 0, undefined, 1, 1, 1024),
		assertCode("SKILL_SOURCE_TOO_LARGE"),
	);

	const error = await loadSkill(missing as never, 0).catch(
		(cause: unknown) => cause,
	);
	assert.ok(error instanceof LazySkillError);
	assert.equal(
		error.message,
		"[SKILL_UNREADABLE] Skill instructions are unreadable.",
	);
	assert.ok(!error.message.includes(missing.filePath));
});

test("loader preserves cancellation before I/O", async () => {
	const controller = new AbortController();
	const reason = new Error("cancelled by test");
	controller.abort(reason);
	await assert.rejects(
		loadSkill(makeSkill("alpha") as never, 0, controller.signal),
		(error: unknown) => error === reason,
	);
});

test("loader observes cancellation immediately after the file read", async () => {
	const skill = await temporarySkill("late-abort", "body");
	const controller = new AbortController();
	const reason = new Error("cancelled after read");
	let abortChecks = 0;
	const signal = new Proxy(controller.signal, {
		get(target, property) {
			if (property === "aborted") {
				abortChecks += 1;
				if (abortChecks === 2) controller.abort(reason);
			}
			const value = Reflect.get(target, property, target) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	await assert.rejects(
		loadSkill(skill as never, 0, signal),
		(error: unknown) => error === reason,
	);
	assert.ok(abortChecks >= 2);
});

test("pagination preserves the 2,000-line and UTF-8-safe giant-line boundaries", async () => {
	const lineSkill = await temporarySkill(
		"line-limit",
		Array.from(
			{ length: MAX_SKILL_LINES + 7 },
			(_, index) => `step-${index + 1}`,
		).join("\n"),
	);
	const first = await loadSkill(lineSkill as never, 0);
	assert.equal(first.bodyTruncation.truncatedBy, "lines");
	assert.equal(first.bodyTruncation.outputLines, MAX_SKILL_LINES);
	assert.equal(first.nextOffset, MAX_SKILL_LINES + 1);
	const second = await loadSkill(
		lineSkill as never,
		0,
		undefined,
		first.nextOffset,
	);
	assert.equal(
		second.body,
		"step-2001\nstep-2002\nstep-2003\nstep-2004\nstep-2005\nstep-2006\nstep-2007",
	);

	const giantLine = "verify-🔥-evidence;".repeat(8_000);
	const giant = await temporarySkill("giant", `${giantLine}\nfinal`);
	let column = 1;
	let reconstructed = "";
	let calls = 0;
	while (true) {
		const chunk = await loadSkill(giant as never, 0, undefined, 1, column);
		const newline = chunk.body.indexOf("\n");
		if (newline !== -1) {
			reconstructed += chunk.body.slice(0, newline);
			assert.equal(chunk.body.slice(newline + 1), "final");
			assert.equal(chunk.nextOffset, undefined);
			break;
		}
		reconstructed += chunk.body;
		assert.ok(Buffer.byteLength(chunk.body, "utf8") <= MAX_SKILL_BYTES);
		assert.equal(chunk.nextOffset, 1);
		assert.ok((chunk.nextColumn ?? 0) > column);
		column = chunk.nextColumn ?? 0;
		calls += 1;
		assert.ok(calls < 10);
	}
	assert.equal(reconstructed, giantLine);
});

test("resource sampling remains opt-in, bounded, and symlink-safe", async () => {
	const skill = await temporarySkill("resources", "body");
	await mkdir(join(skill.baseDir, "references"));
	await writeFile(join(skill.baseDir, "references", "one.md"), "one");
	await writeFile(join(skill.baseDir, ".secret"), "secret");
	const none = await loadSkill(skill as never, 0);
	assert.deepEqual(none.relatedFiles, {
		files: [],
		truncated: false,
		directoriesVisited: 0,
	});
	const sampled = await sampleRelatedFiles(skill.baseDir, skill.filePath, 1);
	assert.deepEqual(sampled.files, [join(skill.baseDir, "references", "one.md")]);
});

interface RegisteredTool {
	name: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: unknown;
	execute(
		toolCallId: string,
		params: { name: string; offset?: number; column?: number },
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<{
		content: Array<{ type: "text"; text: string }>;
		details: Record<string, unknown>;
	}>;
}

interface RegisteredCommand {
	description?: string;
	getArgumentCompletions?: (prefix: string) => unknown;
	handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
}

interface HarnessOptions {
	readonly skills: Skill[];
	readonly activeTools?: string[];
	readonly ownership?: "own" | "foreign";
	readonly trusted?: boolean;
	readonly hasUI?: boolean;
	readonly idle?: boolean;
	readonly selections?: string[];
}

interface Harness {
	readonly pi: ExtensionAPI;
	readonly tool: RegisteredTool;
	readonly commands: Map<string, RegisteredCommand>;
	readonly notifications: Array<{ message: string; type?: string }>;
	readonly sent: Array<{ content: string; options?: Record<string, unknown> }>;
	readonly autocompleteFactories: Array<(provider: unknown) => unknown>;
	readonly ctx: ExtensionContext;
	setSkills(skills: Skill[]): void;
	setActiveTools(names: string[]): void;
	sessionStart(): Promise<void>;
	before(prompt?: string, systemPrompt?: string): Promise<unknown>;
	input(text: string, images?: InputEvent["images"]): Promise<unknown>;
	toolCall(name: string, toolCallId?: string): Promise<unknown>;
	context(messages: unknown[], entries?: unknown[]): Promise<unknown>;
}

async function createHarness(options: HarnessOptions): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), "lazy-harness-"));
	temporaryDirectories.push(root);
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	for (const key of ENV_KEYS.slice(1)) delete process.env[key];

	let skills = options.skills;
	let activeTools = options.activeTools ?? ["read", "bash", "skill"];
	let contextEntries: unknown[] = [];
	const handlers = new Map<
		string,
		(event: never, ctx: ExtensionContext) => unknown
	>();
	const commands = new Map<string, RegisteredCommand>();
	const notifications: Array<{ message: string; type?: string }> = [];
	const sent: Array<{ content: string; options?: Record<string, unknown> }> = [];
	const autocompleteFactories: Array<(provider: unknown) => unknown> = [];
	const selections = [...(options.selections ?? [])];
	let registeredTool: RegisteredTool | undefined;

	const canonicalCommands = (): SlashCommandInfo[] =>
		skills.map((entry) => ({
			name: `skill:${entry.name}`,
			description: entry.description,
			source: "skill",
			sourceInfo: entry.sourceInfo,
		}));
	const piObject = {
		registerTool(tool: RegisteredTool) {
			registeredTool = tool;
		},
		registerCommand(name: string, command: RegisteredCommand) {
			commands.set(name, command);
		},
		on(event: string, handler: (event: never, ctx: ExtensionContext) => unknown) {
			handlers.set(event, handler);
		},
		getCommands: canonicalCommands,
		getActiveTools: () => [...activeTools],
		getAllTools: () => {
			if (!registeredTool) return [];
			return [
				{
					name: "skill",
					description: registeredTool.description,
					parameters: registeredTool.parameters,
					promptGuidelines: registeredTool.promptGuidelines,
					sourceInfo: {
						path:
							options.ownership === "foreign"
								? resolve(root, "foreign-extension.ts")
								: OWN_SOURCE,
						source: options.ownership === "foreign" ? "foreign" : "test",
						scope: "temporary" as const,
						origin: "top-level" as const,
					},
				},
			];
		},
		sendUserMessage(content: string, sendOptions?: Record<string, unknown>) {
			sent.push({ content, options: sendOptions });
		},
	};
	lazySkillTool(piObject as unknown as ExtensionAPI);
	assert.ok(registeredTool);

	const ctxObject = {
		mode: options.hasUI === false ? "print" : "tui",
		hasUI: options.hasUI !== false,
		cwd: root,
		ui: {
			select: async () => selections.shift(),
			confirm: async () => false,
			input: async () => undefined,
			notify(message: string, type?: string) {
				notifications.push({ message, type });
			},
			onTerminalInput: () => () => undefined,
			setStatus: () => undefined,
			setWorkingMessage: () => undefined,
			setWorkingVisible: () => undefined,
			setWorkingIndicator: () => undefined,
			setHiddenThinkingLabel: () => undefined,
			setWidget: () => undefined,
			setFooter: () => undefined,
			setHeader: () => undefined,
			setTitle: () => undefined,
			custom: async () => undefined,
			pasteToEditor: () => undefined,
			setEditorText: () => undefined,
			getEditorText: () => "",
			editor: async () => undefined,
			addAutocompleteProvider(factory: (provider: unknown) => unknown) {
				autocompleteFactories.push(factory);
			},
			setEditorComponent: () => undefined,
		},
		sessionManager: {
			getEntries: () => contextEntries,
			buildContextEntries: () => contextEntries,
		},
		modelRegistry: {},
		model: undefined,
		scopedModels: [],
		isIdle: () => options.idle !== false,
		isProjectTrusted: () => options.trusted !== false,
		signal: undefined,
		abort: () => undefined,
		hasPendingMessages: () => false,
		shutdown: () => undefined,
		getContextUsage: () => undefined,
		compact: () => undefined,
		getSystemPrompt: () => "",
	};
	const ctx = ctxObject as unknown as ExtensionContext;
	const harness: Harness = {
		pi: piObject as unknown as ExtensionAPI,
		tool: registeredTool,
		commands,
		notifications,
		sent,
		autocompleteFactories,
		ctx,
		setSkills(next) {
			skills = next;
		},
		setActiveTools(next) {
			activeTools = next;
		},
		async sessionStart() {
			await handlers.get("session_start")?.(
				{ type: "session_start", reason: "startup" } as never,
				ctx,
			);
		},
		async before(prompt = "", systemPrompt) {
			const promptText =
				systemPrompt ??
				`base${formatSkillsForPrompt(skills, activeTools.includes("read") ? "read" : "bash")}`;
			return handlers.get("before_agent_start")?.(
				{
					type: "before_agent_start",
					prompt,
					systemPrompt: promptText,
					systemPromptOptions: {
						cwd: root,
						skills,
						selectedTools: [...activeTools],
					},
				} as never,
				ctx,
			);
		},
		async input(text, images) {
			return handlers.get("input")?.(
				{ type: "input", text, images, source: "interactive" } as never,
				ctx,
			);
		},
		async toolCall(name, toolCallId = "call") {
			return handlers.get("tool_call")?.(
				{
					type: "tool_call",
					toolName: "skill",
					toolCallId,
					input: { name },
				} as never,
				ctx,
			);
		},
		async context(messages, entries = []) {
			contextEntries = entries;
			return handlers.get("context")?.(
				{ type: "context", messages } as never,
				ctx,
			);
		},
	};
	return harness;
}

function toolContext(
	result: Awaited<ReturnType<RegisteredTool["execute"]>>,
): Record<string, unknown> {
	return JSON.parse(result.content[1]?.text ?? "") as Record<string, unknown>;
}

test("extension registers the compact fixed tool contract", async () => {
	const harness = await createHarness({ skills: [] });
	assert.equal(harness.tool.name, "skill");
	assert.equal(
		harness.tool.description,
		"Load exact-name skill instructions; continue large files with offset and column.",
	);
	assert.equal(
		harness.tool.promptSnippet,
		"Load specialized instructions by exact skill name",
	);
	assert.deepEqual(harness.tool.promptGuidelines, [
		"When an available skill clearly matches the task, load it by exact name before acting.",
	]);
	const serialized = JSON.stringify(harness.tool);
	assert.ok(!serialized.includes("alpha complete description"));
	const schema = harness.tool.parameters as {
		required: string[];
		additionalProperties: boolean;
	};
	assert.deepEqual(schema.required, ["name"]);
	assert.equal(schema.additionalProperties, false);
	assert.ok(harness.commands.has("lazy-skill"));
});

test("canonical discovery feeds safe prompt and frontmatter-free exact-name loading", async () => {
	const discovered = loadSkillsFromDir({ dir: FIXTURE_ROOT, source: "fixture" });
	assert.deepEqual(discovered.diagnostics, []);
	const harness = await createHarness({ skills: discovered.skills });
	await harness.sessionStart();
	const transformed = (await harness.before()) as { systemPrompt: string };
	for (const skill of discovered.skills) {
		assert.ok(transformed.systemPrompt.includes(`<skill name="${skill.name}">`));
		assert.ok(transformed.systemPrompt.includes(skill.description));
		assert.ok(!transformed.systemPrompt.includes(skill.filePath));
	}
	const result = await harness.tool.execute(
		"load-alpha",
		{ name: "alpha" },
		undefined,
		undefined,
		harness.ctx,
	);
	const source = await readFile(discovered.skills[0]?.filePath ?? "", "utf8");
	assert.equal(result.content[0]?.text, parseFrontmatter(source).body);
	assert.deepEqual(toolContext(result), { base: discovered.skills[0]?.baseDir });
	assert.equal(result.details.canonicalPath, discovered.skills[0]?.filePath);
	assert.equal(result.details.resourceFileCount, 0);
});

test("bash fallback and skill-only mode publish the same safe catalog", async () => {
	const alpha = makeSkill("alpha", "Alpha complete description");
	const bashOnly = await createHarness({
		skills: [alpha],
		activeTools: ["bash", "skill"],
	});
	await bashOnly.sessionStart();
	const bashPrompt = (await bashOnly.before()) as { systemPrompt: string };
	assert.ok(bashPrompt.systemPrompt.includes("Alpha complete description"));
	assert.ok(!bashPrompt.systemPrompt.includes(alpha.filePath));

	const skillOnly = await createHarness({
		skills: [alpha],
		activeTools: ["skill"],
	});
	await skillOnly.sessionStart();
	const appended = (await skillOnly.before("", "base prompt")) as {
		systemPrompt: string;
	};
	assert.ok(appended.systemPrompt.startsWith("base prompt\n\n"));
	assert.ok(appended.systemPrompt.includes("Alpha complete description"));
	assert.ok(!appended.systemPrompt.includes(alpha.filePath));
});

test("skill-only restrictive policy sanitizes unexpected native sections", async () => {
	const alpha = makeSkill("alpha", "Alpha restricted description");
	const harness = await createHarness({
		skills: [alpha],
		activeTools: ["skill"],
	});
	await mkdir(join(harness.ctx.cwd, ".pi"), { recursive: true });
	await writeFile(
		join(harness.ctx.cwd, ".pi", "lazy-skill.json"),
		'{"permission":{"skill":"deny"}}',
	);
	await harness.sessionStart();
	const native = formatSkillsForPrompt([alpha], "read");
	const sanitized = (await harness.before("", `base${native}`)) as {
		systemPrompt: string;
	};
	assert.equal(sanitized.systemPrompt, "base");
	assert.ok(!sanitized.systemPrompt.includes(alpha.description));
	assert.ok(!sanitized.systemPrompt.includes(alpha.filePath));

	const ambiguous = (await harness.before("", `${native}\ncustom${native}`)) as {
		systemPrompt: string;
	};
	assert.match(ambiguous.systemPrompt, /SKILL_PROMPT_INTEGRATION_FAILED/u);
	assert.ok(!ambiguous.systemPrompt.includes(alpha.description));
	assert.ok(!ambiguous.systemPrompt.includes(alpha.filePath));
});

test("model-disabled skills are hidden and blocked while remaining canonical commands", async () => {
	const hidden = makeSkill(
		"hidden",
		"Explicit only",
		undefined,
		undefined,
		true,
	);
	const harness = await createHarness({ skills: [hidden] });
	await harness.sessionStart();
	const transformed = await harness.before();
	assert.equal(transformed, undefined);
	assert.ok(
		harness.pi.getCommands().some((command) => command.name === "skill:hidden"),
	);
	const blocked = (await harness.toolCall("hidden")) as {
		block: boolean;
		reason: string;
	};
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /SKILL_DISABLED_FOR_MODEL/u);
	await assert.rejects(
		harness.tool.execute(
			"hidden",
			{ name: "hidden" },
			undefined,
			undefined,
			harness.ctx,
		),
		assertCode("SKILL_DISABLED_FOR_MODEL"),
	);
});

test("foreign tool winner is detected, native metadata is removed, and every model call is blocked", async () => {
	const alpha = makeSkill("alpha", "Alpha description");
	const harness = await createHarness({ skills: [alpha], ownership: "foreign" });
	await harness.sessionStart();
	const transformed = (await harness.before()) as { systemPrompt: string };
	assert.ok(!transformed.systemPrompt.includes(alpha.filePath));
	assert.ok(!transformed.systemPrompt.includes("Alpha description"));
	const blocked = (await harness.toolCall("alpha")) as {
		block: boolean;
		reason: string;
	};
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /SKILL_TOOL_CONFLICT/u);
});

test("inactive own tool leaves permissive native behavior but strips restrictive policy metadata", async () => {
	const alpha = makeSkill("alpha", "Alpha description");
	const permissive = await createHarness({
		skills: [alpha],
		activeTools: ["read"],
	});
	await permissive.sessionStart();
	assert.equal(await permissive.before(), undefined);

	const restrictive = await createHarness({
		skills: [alpha],
		activeTools: ["read"],
	});
	await writeFile(
		join(restrictive.ctx.cwd, ".pi", "lazy-skill.json"),
		'{"permission":{"skill":"deny"}}',
	).catch(async () => {
		await mkdir(join(restrictive.ctx.cwd, ".pi"), { recursive: true });
		await writeFile(
			join(restrictive.ctx.cwd, ".pi", "lazy-skill.json"),
			'{"permission":{"skill":"deny"}}',
		);
	});
	await restrictive.sessionStart();
	const result = (await restrictive.before()) as { systemPrompt: string };
	assert.ok(!result.systemPrompt.includes(alpha.filePath));
	assert.ok(!result.systemPrompt.includes(alpha.description));

	const noReader = await createHarness({
		skills: [alpha],
		activeTools: [],
	});
	await mkdir(join(noReader.ctx.cwd, ".pi"), { recursive: true });
	await writeFile(
		join(noReader.ctx.cwd, ".pi", "lazy-skill.json"),
		'{"permission":{"skill":"deny"}}',
	);
	await noReader.sessionStart();
	const unexpectedNative = `base${formatSkillsForPrompt([alpha], "read")}`;
	const noReaderResult = (await noReader.before("", unexpectedNative)) as {
		systemPrompt: string;
	};
	assert.equal(noReaderResult.systemPrompt, "base");
});

test("restrictive policy fails closed when the exact native prompt section is missing", async () => {
	const alpha = makeSkill("alpha", "Alpha description");
	const harness = await createHarness({ skills: [alpha] });
	await mkdir(join(harness.ctx.cwd, ".pi"), { recursive: true });
	await writeFile(
		join(harness.ctx.cwd, ".pi", "lazy-skill.json"),
		'{"permission":{"skill":"ask"}}',
	);
	await harness.sessionStart();
	const result = (await harness.before(
		"",
		"A different extension replaced the native section.",
	)) as { systemPrompt: string };
	assert.match(result.systemPrompt, /SKILL_PROMPT_INTEGRATION_FAILED/u);
	assert.ok(!result.systemPrompt.includes(alpha.name));
	assert.ok(!result.systemPrompt.includes(alpha.description));
	assert.ok(!result.systemPrompt.includes(alpha.filePath));
});

test("invalid trusted policy hides metadata and blocks model and explicit loading", async () => {
	const alpha = makeSkill("alpha", "Alpha description");
	const harness = await createHarness({ skills: [alpha] });
	await mkdir(join(harness.ctx.cwd, ".pi"), { recursive: true });
	await writeFile(
		join(harness.ctx.cwd, ".pi", "lazy-skill.json"),
		'{"permission":{"skill":"allow","skill":"deny"}}',
	);
	await harness.sessionStart();
	const transformed = (await harness.before()) as { systemPrompt: string };
	assert.ok(!transformed.systemPrompt.includes(alpha.name));
	assert.ok(!transformed.systemPrompt.includes(alpha.description));
	assert.ok(!transformed.systemPrompt.includes(alpha.filePath));
	const blocked = (await harness.toolCall("alpha")) as {
		block: boolean;
		reason: string;
	};
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /POLICY_INVALID/u);
	assert.deepEqual(await harness.input("/skill:alpha"), { action: "handled" });
	assert.match(harness.notifications.at(-1)?.message ?? "", /POLICY_INVALID/u);
});

test("session reload applies changed policy before the next model turn", async () => {
	const alpha = makeSkill("alpha", "Alpha description");
	const harness = await createHarness({ skills: [alpha] });
	await harness.sessionStart();
	const initial = (await harness.before()) as { systemPrompt: string };
	assert.ok(initial.systemPrompt.includes("Alpha description"));

	await mkdir(join(harness.ctx.cwd, ".pi"), { recursive: true });
	await writeFile(
		join(harness.ctx.cwd, ".pi", "lazy-skill.json"),
		'{"permission":{"skill":"deny"}}',
	);
	await harness.sessionStart();
	const reloaded = (await harness.before()) as { systemPrompt: string };
	assert.ok(!reloaded.systemPrompt.includes(alpha.name));
	assert.ok(!reloaded.systemPrompt.includes(alpha.description));
	assert.ok(!reloaded.systemPrompt.includes(alpha.filePath));
	const blocked = (await harness.toolCall("alpha", "after-policy-reload")) as {
		block: boolean;
		reason: string;
	};
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /SKILL_DENIED/u);
});

test("tool invocation captures one immutable snapshot across a registry reload", async () => {
	const alpha = makeSkill("alpha", "Alpha description");
	const beta = makeSkill("beta", "Beta description");
	const harness = await createHarness({ skills: [alpha] });
	await harness.sessionStart();
	await harness.before();
	const pending = harness.tool.execute(
		"in-flight",
		{ name: "alpha" },
		undefined,
		undefined,
		harness.ctx,
	);
	harness.setSkills([beta]);
	await harness.before();
	const loaded = await pending;
	assert.ok(loaded.content[0]?.text.includes("# Alpha"));
	await assert.rejects(
		harness.tool.execute(
			"new",
			{ name: "alpha" },
			undefined,
			undefined,
			harness.ctx,
		),
		assertCode("SKILL_NOT_FOUND"),
	);
});

test("a failed snapshot rebuild leaves the prior generation available", async () => {
	const alpha = makeSkill("alpha", "Alpha description");
	const harness = await createHarness({ skills: [alpha] });
	await harness.sessionStart();
	await harness.before();
	const malformed = {
		get name(): string {
			throw new Error("synthetic index build failure");
		},
	} as Skill;
	harness.setSkills([malformed]);
	const failed = (await harness.before("", "base")) as { systemPrompt: string };
	assert.match(failed.systemPrompt, /SKILL_PROMPT_INTEGRATION_FAILED/u);
	const result = await harness.tool.execute(
		"after-failure",
		{ name: "alpha" },
		undefined,
		undefined,
		harness.ctx,
	);
	assert.ok(result.content[0]?.text.includes("# Alpha"));
});

test("real-world skill keeps complete late routing text and reduces loaded payload", async () => {
	const discovered = loadSkillsFromDir({
		dir: REAL_WORLD_FIXTURE_ROOT,
		source: "real-world",
	});
	const skill = discovered.skills[0];
	assert.ok(skill);
	const harness = await createHarness({ skills: discovered.skills });
	await harness.sessionStart();
	const prompt = (await harness.before()) as { systemPrompt: string };
	assert.ok(
		prompt.systemPrompt.includes("investigate a real production incident"),
	);
	const result = await harness.tool.execute(
		"real-world",
		{ name: skill.name },
		undefined,
		undefined,
		harness.ctx,
	);
	const raw = await readFile(skill.filePath, "utf8");
	assert.equal(result.content[0]?.text, parseFrontmatter(raw).body);
	assert.ok(
		Buffer.byteLength(result.content[0]?.text ?? "") < Buffer.byteLength(raw),
	);
	assert.ok(
		!(result.content[0]?.text ?? "").includes("allowed-tools: read bash"),
	);
});

test("resolved tool ownership fails closed for both registration orders", () => {
	const foreignSource = resolve("test", "foreign-extension.ts");
	const sourceInfo = (path: string) => ({
		path,
		source: "test",
		scope: "temporary" as const,
		origin: "top-level" as const,
	});
	for (const [registrations, expected] of [
		[[foreignSource, OWN_SOURCE], "owned"],
		[[OWN_SOURCE, foreignSource], "foreign"],
	] as const) {
		const winner = registrations.at(-1);
		assert.ok(winner);
		const ownership = inspectSkillToolOwnership(
			{
				getAllTools: () => [
					{
						name: "skill",
						label: "Skill",
						description: "test",
						parameters: {},
						sourceInfo: sourceInfo(winner),
					},
				],
				getActiveTools: () => ["skill"],
			} as never,
			OWN_SOURCE,
		);
		assert.equal(ownership.status, expected);
	}
});

test("canonical comparison handles POSIX and Windows path forms", () => {
	assert.equal(
		canonicalComparisonPath(
			"C:\\Users\\Alice\\Skill\\..\\Skill\\SKILL.md",
			"win32",
		),
		"c:\\users\\alice\\skill\\skill.md",
	);
	assert.equal(
		canonicalComparisonPath("file:///C:/Users/Alice/Skill/SKILL.md", "win32"),
		"c:\\users\\alice\\skill\\skill.md",
	);
	assert.equal(canonicalComparisonPath("/tmp/a/../b", "linux"), "/tmp/b");
	assert.equal(canonicalComparisonPath("file:///tmp/a/../b", "linux"), "/tmp/b");
});
