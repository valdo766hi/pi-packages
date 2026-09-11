import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Skill,
	SlashCommandInfo,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import {
	authorizeExplicitInvocation,
	authorizeModelExecution,
	authorizeModelToolCall,
	createAuthorizationState,
	forwardedNativeSkillCommand,
	guardSkillContext,
	parseExplicitSkillInvocation,
	pruneAuthorizationState,
	resetAuthorizationState,
	transformAuthorizedInput,
} from "./src/authorization.ts";
import { readConfig } from "./src/config.ts";
import { LazySkillError } from "./src/errors.ts";
import { compileSkillPolicy } from "./src/policy.ts";
import {
	canonicalSkillCommands,
	installLazySkillAutocomplete,
	parseLazyCommandArguments,
	registerLazySkillCommand,
	skillsFromCanonicalCommands,
} from "./src/slash-command.ts";
import { buildSkillSnapshot, type SkillSnapshot } from "./src/snapshot.ts";
import type { SkillToolOwnership } from "./src/tool-ownership.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function createSkill(
	name: string,
	options: {
		readonly description?: string;
		readonly body?: string;
		readonly disabled?: boolean;
		readonly source?: string;
		readonly scope?: "user" | "project" | "temporary";
	} = {},
): Promise<Skill> {
	const directory = await mkdtemp(join(tmpdir(), `lazy-slash-${name}-`));
	temporaryDirectories.push(directory);
	const filePath = join(directory, "SKILL.md");
	const description = options.description ?? `${name} complete description`;
	const disabledLine = options.disabled
		? "\ndisable-model-invocation: true"
		: "";
	await writeFile(
		filePath,
		`---\nname: ${name}\ndescription: ${description}${disabledLine}\n---\n${options.body ?? `# ${name}\n\nInstructions for ${name}.`}\n`,
	);
	return {
		name,
		description,
		filePath,
		baseDir: directory,
		disableModelInvocation: options.disabled ?? false,
		sourceInfo: {
			path: filePath,
			source: options.source ?? "test",
			scope: options.scope ?? "temporary",
			origin: (options.source ?? "").startsWith("package:")
				? "package"
				: "top-level",
			baseDir: directory,
		},
	};
}

function snapshot(
	skills: readonly Skill[],
	defaultAction: "allow" | "ask" | "deny" = "allow",
	rules: Array<{ pattern: string; action: "allow" | "ask" | "deny" }> = [],
): SkillSnapshot {
	return buildSkillSnapshot(
		skills,
		readConfig({}).config,
		compileSkillPolicy({ defaultAction, rules }),
	);
}

interface ContextHarness {
	readonly ctx: ExtensionContext;
	readonly notifications: Array<{ message: string; type?: string }>;
	readonly prompts: string[][];
	setEntries(entries: unknown[]): void;
}

function extensionContext(
	options: {
		readonly hasUI?: boolean;
		readonly choices?: Array<string | undefined>;
		readonly idle?: boolean;
	} = {},
): ContextHarness {
	const notifications: Array<{ message: string; type?: string }> = [];
	const prompts: string[][] = [];
	const choices = [...(options.choices ?? [])];
	let entries: unknown[] = [];
	const ctx = {
		mode: options.hasUI === false ? "print" : "tui",
		hasUI: options.hasUI !== false,
		cwd: process.cwd(),
		ui: {
			async select(_title: string, values: string[]) {
				prompts.push(values);
				return choices.shift();
			},
			notify(message: string, type?: string) {
				notifications.push({ message, type });
			},
		},
		sessionManager: {
			getEntries: () => entries,
			buildContextEntries: () => entries,
		},
		isIdle: () => options.idle !== false,
		isProjectTrusted: () => true,
		signal: undefined,
	} as unknown as ExtensionContext;
	return {
		ctx,
		notifications,
		prompts,
		setEntries(next) {
			entries = next;
		},
	};
}

function expandedSkill(skill: Skill, args = ""): string {
	const body = `# ${skill.name}\n\nInstructions for ${skill.name}.`;
	return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>${args ? `\n\n${args.trim()}` : ""}`;
}

function userMessage(text: string, timestamp = Date.now()) {
	return {
		role: "user" as const,
		content: [{ type: "text" as const, text }],
		timestamp,
	};
}

function sessionEntry(id: string, message: ReturnType<typeof userMessage>) {
	return {
		type: "message" as const,
		id,
		parentId: null,
		timestamp: new Date(message.timestamp).toISOString(),
		message,
	};
}

function ownOwnership(): SkillToolOwnership {
	return {
		status: "owned",
		active: true,
		ownSource: "/extension/index.ts",
		resolvedSource: "/extension/index.ts",
	};
}

function assertErrorCode(code: string): (error: unknown) => boolean {
	return (error) => error instanceof LazySkillError && error.code === code;
}

test("explicit slash parsers follow Pi's literal-space grammar without reserializing arguments", () => {
	assert.deepEqual(parseLazyCommandArguments('  alpha one  two "three"'), {
		name: "alpha",
		args: 'one  two "three"',
	});
	assert.equal(parseLazyCommandArguments("   "), undefined);
	assert.deepEqual(parseExplicitSkillInvocation("/lazy-skill:alpha one  two"), {
		prefix: "lazy-skill",
		name: "alpha",
		args: "one  two",
	});
	assert.deepEqual(parseExplicitSkillInvocation("/skill:alpha"), {
		prefix: "skill",
		name: "alpha",
		args: "",
	});
	assert.equal(parseExplicitSkillInvocation("prefix /skill:alpha"), undefined);
	const invocation = parseExplicitSkillInvocation("/lazy-skill:alpha one  two");
	assert.ok(invocation);
	assert.equal(forwardedNativeSkillCommand(invocation), "/skill:alpha one  two");
	assert.deepEqual(
		transformAuthorizedInput(
			{
				type: "input",
				text: "/lazy-skill:alpha",
				images: [{ type: "image", data: "abc", mimeType: "image/png" }],
				source: "interactive",
			},
			invocation,
		),
		{
			action: "transform",
			text: "/skill:alpha one  two",
			images: [{ type: "image", data: "abc", mimeType: "image/png" }],
		},
	);
});

test("ask approval is once, session-scoped, rejectable, and fail-closed without UI", async () => {
	const alpha = await createSkill("alpha");
	const current = snapshot([alpha], "ask");

	const onceState = createAuthorizationState();
	const onceContext = extensionContext({ choices: ["Allow once"] });
	await authorizeExplicitInvocation(
		{ prefix: "skill", name: "alpha", args: "details" },
		onceContext.ctx,
		current,
		onceState,
	);
	assert.equal(onceContext.prompts.length, 1);
	assert.equal(onceState.explicitTickets.length, 1);

	const sessionState = createAuthorizationState();
	const sessionContext = extensionContext({
		choices: ["Always allow this skill for this session"],
	});
	await authorizeExplicitInvocation(
		{ prefix: "skill", name: "alpha", args: "" },
		sessionContext.ctx,
		current,
		sessionState,
	);
	await authorizeExplicitInvocation(
		{ prefix: "lazy-skill", name: "alpha", args: "again" },
		sessionContext.ctx,
		current,
		sessionState,
	);
	assert.equal(sessionContext.prompts.length, 1);

	const rejected = extensionContext({ choices: ["Reject"] });
	await assert.rejects(
		authorizeExplicitInvocation(
			{ prefix: "skill", name: "alpha", args: "" },
			rejected.ctx,
			current,
			createAuthorizationState(),
		),
		assertErrorCode("SKILL_APPROVAL_REJECTED"),
	);
	const headless = extensionContext({ hasUI: false });
	await assert.rejects(
		authorizeExplicitInvocation(
			{ prefix: "skill", name: "alpha", args: "" },
			headless.ctx,
			current,
			createAuthorizationState(),
		),
		assertErrorCode("SKILL_APPROVAL_REQUIRED"),
	);
});

test("session reset clears skill approvals", async () => {
	const alpha = await createSkill("alpha");
	const current = snapshot([alpha], "ask");
	const state = createAuthorizationState();
	const context = extensionContext({
		choices: ["Always allow this skill for this session"],
	});
	await authorizeExplicitInvocation(
		{ prefix: "skill", name: "alpha", args: "" },
		context.ctx,
		current,
		state,
	);
	assert.equal(state.sessionApprovals.size, 1);
	resetAuthorizationState(state);
	assert.equal(state.sessionApprovals.size, 0);
	assert.equal(state.modelTickets.size, 0);
	assert.equal(state.explicitTickets.length, 0);
	assert.equal(state.authorizedBlocks.size, 0);
});

test("two identical allow-once invocations require and consume independent approvals", async () => {
	const alpha = await createSkill("alpha");
	const current = snapshot([alpha], "ask");
	const state = createAuthorizationState();
	const context = extensionContext({ choices: ["Allow once", "Allow once"] });
	for (let index = 0; index < 2; index += 1) {
		await authorizeExplicitInvocation(
			{ prefix: "skill", name: "alpha", args: "same" },
			context.ctx,
			current,
			state,
		);
	}
	assert.equal(context.prompts.length, 2);
	assert.equal(state.explicitTickets.length, 2);
	const first = userMessage(expandedSkill(alpha, "same"), Date.now() + 10);
	const second = userMessage(expandedSkill(alpha, "same"), first.timestamp + 1);
	context.setEntries([
		sessionEntry("first", first),
		sessionEntry("second", second),
	]);
	assert.equal(
		await guardSkillContext(
			{ type: "context", messages: [first, second] },
			context.ctx,
			current,
			state,
		),
		undefined,
	);
	assert.equal(state.explicitTickets.length, 0);
});

test("model ask authorization prompts once across tool_call and own execution", async () => {
	const alpha = await createSkill("alpha");
	const current = snapshot([alpha], "ask");
	const state = createAuthorizationState();
	const context = extensionContext({ choices: ["Allow once"] });
	const event = {
		type: "tool_call",
		toolName: "skill",
		toolCallId: "call-1",
		input: { name: "alpha" },
	} as ToolCallEvent;
	assert.equal(
		await authorizeModelToolCall(
			event,
			context.ctx,
			current,
			state,
			ownOwnership(),
		),
		undefined,
	);
	const resolved = await authorizeModelExecution(
		"call-1",
		"alpha",
		context.ctx,
		current,
		state,
		ownOwnership(),
	);
	assert.equal(resolved.name, "alpha");
	assert.equal(context.prompts.length, 1);
	assert.equal(state.modelTickets.size, 0);

	const foreign = await authorizeModelToolCall(
		event,
		context.ctx,
		current,
		state,
		{
			status: "foreign",
			active: true,
			ownSource: "/own.ts",
			resolvedSource: "/foreign.ts",
		},
	);
	assert.equal(foreign?.block, true);
	assert.match(foreign?.reason ?? "", /SKILL_TOOL_CONFLICT/u);
});

test("deny blocks both model boundary and own execution without prompting", async () => {
	const secret = await createSkill("secret");
	const current = snapshot([secret], "deny");
	const state = createAuthorizationState();
	const context = extensionContext();
	const event = {
		type: "tool_call",
		toolName: "skill",
		toolCallId: "deny-call",
		input: { name: "secret" },
	} as ToolCallEvent;
	const blocked = await authorizeModelToolCall(
		event,
		context.ctx,
		current,
		state,
		ownOwnership(),
	);
	assert.equal(blocked?.block, true);
	assert.equal(
		blocked?.reason,
		"[SKILL_DENIED] Skill loading is denied by policy.",
	);
	assert.equal(context.prompts.length, 0);
	await assert.rejects(
		authorizeModelExecution(
			"deny-call",
			"secret",
			context.ctx,
			current,
			state,
			ownOwnership(),
		),
		assertErrorCode("SKILL_DENIED"),
	);
});

test("disable-model-invocation blocks the model but not explicit user authorization", async () => {
	const hidden = await createSkill("hidden", { disabled: true });
	const current = snapshot([hidden]);
	const state = createAuthorizationState();
	const context = extensionContext();
	await assert.rejects(
		authorizeModelExecution(
			"call",
			"hidden",
			context.ctx,
			current,
			state,
			ownOwnership(),
		),
		assertErrorCode("SKILL_DISABLED_FOR_MODEL"),
	);
	const explicit = await authorizeExplicitInvocation(
		{ prefix: "skill", name: "hidden", args: "" },
		context.ctx,
		current,
		state,
	);
	assert.equal(explicit.name, "hidden");
});

test("the final context guard binds one ask approval to one exact canonical message", async () => {
	const alpha = await createSkill("alpha");
	const current = snapshot([alpha], "ask");
	const state = createAuthorizationState();
	const context = extensionContext({ choices: ["Allow once"] });
	await authorizeExplicitInvocation(
		{ prefix: "skill", name: "alpha", args: "details" },
		context.ctx,
		current,
		state,
	);
	const first = userMessage(expandedSkill(alpha, "details"), Date.now() + 10);
	context.setEntries([sessionEntry("entry-1", first)]);
	const event = { type: "context", messages: [first] } as ContextEvent;
	assert.equal(
		await guardSkillContext(event, context.ctx, current, state),
		undefined,
	);
	assert.equal(state.explicitTickets.length, 0);
	assert.equal(
		await guardSkillContext(event, context.ctx, current, state),
		undefined,
	);

	const second = userMessage(
		expandedSkill(alpha, "details"),
		first.timestamp + 1,
	);
	context.setEntries([
		sessionEntry("entry-1", first),
		sessionEntry("entry-2", second),
	]);
	const blocked = await guardSkillContext(
		{ type: "context", messages: [first, second] },
		context.ctx,
		current,
		state,
	);
	assert.ok(blocked);
	const blockedText = (blocked.messages[1] as typeof second).content[0];
	assert.equal(blockedText?.type, "text");
	assert.match(
		blockedText?.type === "text" ? blockedText.text : "",
		/SKILL_APPROVAL_REQUIRED/u,
	);
});

test("manual blocks, changed arguments, names, paths, and denied policy cannot bypass the context guard", async () => {
	const alpha = await createSkill("alpha");
	const beta = await createSkill("beta");
	const gamma = await createSkill("gamma");
	const current = snapshot([alpha, beta, gamma], "ask", [
		{ pattern: "beta", action: "deny" },
	]);
	const state = createAuthorizationState();
	const context = extensionContext({ choices: ["Allow once"] });

	const pasted = userMessage(expandedSkill(alpha), Date.now() + 10);
	let result = await guardSkillContext(
		{ type: "context", messages: [pasted] },
		context.ctx,
		current,
		state,
	);
	assert.match(
		((result?.messages[0] as typeof pasted).content[0] as { text: string }).text,
		/SKILL_APPROVAL_REQUIRED/u,
	);

	await authorizeExplicitInvocation(
		{ prefix: "skill", name: "alpha", args: "approved" },
		context.ctx,
		current,
		state,
	);
	const changedArgs = userMessage(
		expandedSkill(alpha, "changed"),
		Date.now() + 20,
	);
	result = await guardSkillContext(
		{ type: "context", messages: [changedArgs] },
		context.ctx,
		current,
		state,
	);
	assert.match(
		((result?.messages[0] as typeof changedArgs).content[0] as { text: string })
			.text,
		/SKILL_APPROVAL_REQUIRED/u,
	);

	const changedName = userMessage(
		expandedSkill(gamma, "approved"),
		Date.now() + 25,
	);
	result = await guardSkillContext(
		{ type: "context", messages: [changedName] },
		context.ctx,
		current,
		state,
	);
	assert.match(
		((result?.messages[0] as typeof changedName).content[0] as { text: string })
			.text,
		/SKILL_APPROVAL_REQUIRED/u,
	);

	const denied = userMessage(expandedSkill(beta), Date.now() + 30);
	result = await guardSkillContext(
		{ type: "context", messages: [denied] },
		context.ctx,
		current,
		state,
	);
	const deniedText = (
		(result?.messages[0] as typeof denied).content[0] as { text: string }
	).text;
	assert.equal(deniedText, "[SKILL_DENIED] Skill loading is denied by policy.");
	assert.ok(!deniedText.includes(beta.name));
	assert.ok(!deniedText.includes(beta.filePath));

	const wrongPath = userMessage(
		expandedSkill(alpha).replace(
			alpha.filePath,
			join(dirname(alpha.filePath), "other.md"),
		),
		Date.now() + 40,
	);
	result = await guardSkillContext(
		{ type: "context", messages: [wrongPath] },
		context.ctx,
		current,
		state,
	);
	assert.match(
		((result?.messages[0] as typeof wrongPath).content[0] as { text: string })
			.text,
		/SKILL_NOT_FOUND/u,
	);
});

test("approval caches are invalidated by canonical path and policy fingerprint changes", async () => {
	const alpha = await createSkill("alpha");
	const first = snapshot([alpha], "ask");
	const state = createAuthorizationState();
	const context = extensionContext({
		choices: ["Always allow this skill for this session", "Allow once"],
	});
	await authorizeExplicitInvocation(
		{ prefix: "skill", name: "alpha", args: "" },
		context.ctx,
		first,
		state,
	);
	assert.equal(state.sessionApprovals.size, 1);

	const moved = {
		...alpha,
		filePath: join(alpha.baseDir, "moved", "SKILL.md"),
		baseDir: join(alpha.baseDir, "moved"),
		sourceInfo: {
			...alpha.sourceInfo,
			path: join(alpha.baseDir, "moved", "SKILL.md"),
			baseDir: join(alpha.baseDir, "moved"),
		},
	};
	const second = snapshot([moved], "ask");
	pruneAuthorizationState(state, second);
	assert.equal(state.sessionApprovals.size, 0);
	await authorizeExplicitInvocation(
		{ prefix: "skill", name: "alpha", args: "" },
		context.ctx,
		second,
		state,
	);
	assert.equal(context.prompts.length, 2);

	const third = snapshot([moved], "ask", [{ pattern: "other", action: "deny" }]);
	pruneAuthorizationState(state, third);
	assert.equal(state.sessionApprovals.size, 0);
});

interface CommandHarness {
	readonly pi: ExtensionAPI;
	readonly registered: Map<
		string,
		{
			description?: string;
			getArgumentCompletions?: (prefix: string) => unknown;
			handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
		}
	>;
	readonly sent: Array<{ content: string; options?: Record<string, unknown> }>;
}

function commandHarness(skills: readonly Skill[]): CommandHarness {
	const registered = new Map<
		string,
		{
			description?: string;
			getArgumentCompletions?: (prefix: string) => unknown;
			handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
		}
	>();
	const sent: Array<{ content: string; options?: Record<string, unknown> }> = [];
	const commands: SlashCommandInfo[] = skills.map((skill) => ({
		name: `skill:${skill.name}`,
		description: skill.description,
		source: "skill",
		sourceInfo: skill.sourceInfo,
	}));
	const pi = {
		getCommands: () => commands,
		registerCommand(
			name: string,
			options: CommandHarness["registered"] extends Map<string, infer V>
				? V
				: never,
		) {
			registered.set(name, options);
		},
		sendUserMessage(content: string, options?: Record<string, unknown>) {
			sent.push({ content, options });
		},
	} as unknown as ExtensionAPI;
	return { pi, registered, sent };
}

function commandContext(
	options: {
		readonly hasUI?: boolean;
		readonly idle?: boolean;
		readonly selection?: string;
		readonly notifications?: string[];
	} = {},
): ExtensionCommandContext {
	return {
		hasUI: options.hasUI !== false,
		isIdle: () => options.idle !== false,
		ui: {
			select: async () => options.selection,
			notify: (message: string) => options.notifications?.push(message),
		},
	} as unknown as ExtensionCommandContext;
}

test("/lazy-skill forwards canonical commands, preserves arguments, and supports streaming", async () => {
	const global = await createSkill("global-skill", {
		source: "global",
		scope: "user",
	});
	const packaged = await createSkill("package-skill", {
		source: "package:demo",
		scope: "user",
	});
	const harness = commandHarness([global, packaged]);
	const current = snapshot([global, packaged]);
	registerLazySkillCommand(harness.pi, () => current);
	const command = harness.registered.get("lazy-skill");
	assert.ok(command);
	await command.handler(
		'global-skill one  two "unchanged"',
		commandContext({ idle: false }),
	);
	assert.deepEqual(harness.sent, [
		{
			content: '/skill:global-skill one  two "unchanged"',
			options: { deliverAs: "followUp", expandPromptTemplates: true },
		},
	]);
	const completions = (await command.getArgumentCompletions?.("pack")) as Array<{
		value: string;
		description: string;
	}>;
	assert.deepEqual(
		completions.map(({ value }) => value),
		["package-skill"],
	);
	assert.match(completions[0]?.description ?? "", /user\/package:demo/u);
});

test("/lazy-skill selector excludes deny, annotates ask, and handles no-UI or unknown names", async () => {
	const alpha = await createSkill("alpha", { description: "Complete alpha" });
	const secret = await createSkill("secret", { description: "Never show" });
	const harness = commandHarness([alpha, secret]);
	const current = snapshot([alpha, secret], "allow", [
		{ pattern: "alpha", action: "ask" },
		{ pattern: "secret", action: "deny" },
	]);
	registerLazySkillCommand(harness.pi, () => current);
	const command = harness.registered.get("lazy-skill");
	assert.ok(command);
	const expectedLabel = "alpha — Complete alpha [temporary/test, ask]";
	await command.handler("", commandContext({ selection: expectedLabel }));
	assert.equal(harness.sent[0]?.content, "/skill:alpha");

	const notifications: string[] = [];
	await command.handler("", commandContext({ hasUI: false, notifications }));
	await command.handler("unknown", commandContext({ notifications }));
	assert.match(notifications[0] ?? "", /Usage/u);
	assert.match(notifications[1] ?? "", /not available/u);
});

test("canonical command projection preserves Pi scope/source and resolved names", async () => {
	const skill = await createSkill("temporary-skill", {
		source: "cli:--skill",
		scope: "temporary",
	});
	const harness = commandHarness([skill]);
	assert.deepEqual(
		[...canonicalSkillCommands(harness.pi).keys()],
		["temporary-skill"],
	);
	const projected = skillsFromCanonicalCommands(harness.pi, process.cwd());
	assert.equal(projected[0]?.filePath, skill.filePath);
	assert.equal(projected[0]?.baseDir, skill.baseDir);
	assert.deepEqual(projected[0]?.sourceInfo, skill.sourceInfo);
});

test("command completions resolve Pi's live registry after a reload", async () => {
	const alpha = await createSkill("alpha");
	const beta = await createSkill("beta");
	let commands: SlashCommandInfo[] = [
		{
			name: "skill:alpha",
			description: alpha.description,
			source: "skill",
			sourceInfo: alpha.sourceInfo,
		},
	];
	let current = snapshot([alpha]);
	let registered:
		| {
				getArgumentCompletions?: (prefix: string) => unknown;
		  }
		| undefined;
	const pi = {
		getCommands: () => commands,
		registerCommand(_name: string, options: typeof registered) {
			registered = options;
		},
		sendUserMessage() {},
	} as unknown as ExtensionAPI;
	registerLazySkillCommand(pi, () => current);
	assert.ok(registered);
	assert.deepEqual(
		(
			(await registered.getArgumentCompletions?.("")) as Array<{ value: string }>
		).map(({ value }) => value),
		["alpha"],
	);
	commands = [
		{
			name: "skill:beta",
			description: beta.description,
			source: "skill",
			sourceInfo: beta.sourceInfo,
		},
	];
	current = snapshot([beta]);
	assert.deepEqual(
		(
			(await registered.getArgumentCompletions?.("")) as Array<{ value: string }>
		).map(({ value }) => value),
		["beta"],
	);
});

test("colon autocomplete composes with and delegates to Pi's existing provider", async () => {
	const alpha = await createSkill("alpha", { description: "Complete alpha" });
	const denied = await createSkill("denied", { description: "Denied" });
	const harness = commandHarness([alpha, denied]);
	const current = snapshot([alpha, denied], "allow", [
		{ pattern: "denied", action: "deny" },
	]);
	let factory: ((provider: unknown) => unknown) | undefined;
	const context = {
		ui: {
			addAutocompleteProvider(next: (provider: unknown) => unknown) {
				factory = next;
			},
		},
	} as unknown as Pick<ExtensionCommandContext, "ui">;
	installLazySkillAutocomplete(context, harness.pi, () => current);
	assert.ok(factory);
	let delegated = 0;
	const base = {
		triggerCharacters: ["/"],
		async getSuggestions() {
			delegated += 1;
			return { items: [{ value: "base", label: "base" }], prefix: "b" };
		},
		applyCompletion(lines: string[], cursorLine: number, cursorCol: number) {
			return { lines, cursorLine, cursorCol };
		},
		shouldTriggerFileCompletion: () => true,
	};
	const provider = factory(base) as {
		triggerCharacters: string[];
		getSuggestions(
			lines: string[],
			cursorLine: number,
			cursorCol: number,
			options: { signal: AbortSignal },
		): Promise<{
			items: Array<{ value: string; description?: string }>;
			prefix: string;
		} | null>;
		applyCompletion(
			lines: string[],
			cursorLine: number,
			cursorCol: number,
			item: { value: string; label: string },
			prefix: string,
		): { lines: string[]; cursorLine: number; cursorCol: number };
	};
	const signal = new AbortController().signal;
	const unrelated = await provider.getSuggestions(["ordinary"], 0, 8, {
		signal,
	});
	assert.equal(delegated, 1);
	assert.equal(unrelated?.items[0]?.value, "base");
	const lazy = await provider.getSuggestions(["/lazy-skill:a"], 0, 13, {
		signal,
	});
	assert.equal(delegated, 1);
	assert.deepEqual(
		lazy?.items.map(({ value }) => value),
		["/lazy-skill:alpha"],
	);
	assert.ok(!JSON.stringify(lazy).includes("denied"));
	const applied = provider.applyCompletion(
		["/lazy-skill:a trailing"],
		0,
		13,
		{ value: "/lazy-skill:alpha", label: "alpha" },
		"/lazy-skill:a",
	);
	assert.equal(applied.lines[0], "/lazy-skill:alpha trailing");
	assert.ok(provider.triggerCharacters.includes(":"));
});
