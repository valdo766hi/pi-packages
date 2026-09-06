import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "typebox";
import {
	authorizeExplicitInvocation,
	authorizeModelExecution,
	authorizeModelToolCall,
	clearPendingExplicitAuthorizations,
	createAuthorizationState,
	guardSkillContext,
	parseExplicitSkillInvocation,
	pruneAuthorizationState,
	resetAuthorizationState,
	transformAuthorizedInput,
	type SkillAuthorizationState,
} from "./authorization.ts";
import { renderAdaptiveCatalog, type RuntimeSkill } from "./catalog.ts";
import { loadConfig, readConfig, type ConfigResult } from "./config.ts";
import { LazySkillError } from "./errors.ts";
import { loadSkill } from "./loader.ts";
import {
	replaceCanonicalSkillPrompt,
	replaceOrAppendCanonicalSkillCatalog,
	type NativeSkillReadTool,
	type PromptTransformResult,
} from "./prompt.ts";
import { buildRoutingQuery, selectRoutingSkills } from "./routing.ts";
import {
	canonicalSkillCommands,
	installLazySkillAutocomplete,
	registerLazySkillCommand,
	skillsFromCanonicalCommands,
} from "./slash-command.ts";
import { buildSkillSnapshot, type SkillSnapshot } from "./snapshot.ts";
import {
	canonicalComparisonPath,
	inspectSkillToolOwnership,
	type SkillToolOwnership,
} from "./tool-ownership.ts";

const TOOL_DESCRIPTION =
	"Load exact-name skill instructions; continue large files with offset and column.";
const TOOL_PROMPT_SNIPPET = "Load specialized instructions by exact skill name";
const TOOL_GUIDELINE =
	"When an available skill clearly matches the task, load it by exact name before acting.";
const OWN_MODULE_PATH = fileURLToPath(import.meta.url);

const PARAMETERS = Type.Object(
	{
		name: Type.String({ minLength: 1 }),
		offset: Type.Optional(Type.Integer({ minimum: 1 })),
		column: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);

type SkillToolParams = Static<typeof PARAMETERS>;

interface ToolResultInput {
	readonly snapshot: SkillSnapshot;
	readonly skill: RuntimeSkill;
	readonly body: string;
	readonly bodyOffset: number;
	readonly bodyColumn: number;
	readonly bodyTruncation: TruncationResult;
	readonly nextOffset?: number;
	readonly nextColumn?: number;
	readonly files: readonly string[];
	readonly filesTruncated: boolean;
	readonly directoriesVisited: number;
}

export interface SkillToolDetails {
	readonly name: string;
	readonly canonicalPath: string;
	readonly baseDir: string;
	readonly sourceInfo: RuntimeSkill["sourceInfo"];
	readonly policy: "allow" | "ask";
	readonly snapshotFingerprint: string;
	readonly resourceFileCount: number;
	readonly resourceFilesTruncated: boolean;
	readonly directoriesVisited: number;
	readonly bodyOffset: number;
	readonly bodyColumn: number;
	readonly bodyTruncated: boolean;
	readonly nextOffset?: number;
	readonly nextColumn?: number;
}

interface ExtensionState {
	snapshot?: SkillSnapshot;
	configResult?: ConfigResult;
	configPromise?: Promise<ConfigResult>;
	ownership: SkillToolOwnership;
	readonly authorization: SkillAuthorizationState;
	readonly warnedConditions: Set<string>;
	publicationBlocked: boolean;
	autocompleteInstalled: boolean;
}

function toolResult({
	snapshot,
	skill,
	body,
	bodyOffset,
	bodyColumn,
	bodyTruncation,
	nextOffset,
	nextColumn,
	files,
	filesTruncated,
	directoriesVisited,
}: ToolResultInput) {
	const context: {
		base: string;
		next?: { offset: number; column: number };
		resources?: string[];
		resourcesTruncated?: true;
	} = { base: skill.baseDir };
	if (nextOffset !== undefined) {
		context.next = { offset: nextOffset, column: nextColumn ?? 1 };
	}
	if (files.length > 0) {
		context.resources = files.map((file) => relative(skill.baseDir, file));
		if (filesTruncated) context.resourcesTruncated = true;
	}

	const details: SkillToolDetails = {
		name: skill.name,
		canonicalPath: skill.filePath,
		baseDir: skill.baseDir,
		sourceInfo: skill.sourceInfo,
		policy: snapshot.policy.decision(skill.name) as "allow" | "ask",
		snapshotFingerprint: snapshot.fingerprint,
		resourceFileCount: files.length,
		resourceFilesTruncated: filesTruncated,
		directoriesVisited,
		bodyOffset,
		bodyColumn,
		bodyTruncated: bodyTruncation.truncated,
		...(nextOffset === undefined
			? {}
			: { nextOffset, nextColumn: nextColumn ?? 1 }),
	};
	return {
		content: [
			{ type: "text" as const, text: body },
			{ type: "text" as const, text: JSON.stringify(context) },
		],
		details,
	};
}

function warnOnce(state: ExtensionState, warning: string): void {
	if (state.warnedConditions.has(warning)) return;
	state.warnedConditions.add(warning);
	process.emitWarning(warning, { code: "PI_LAZY_SKILL_TOOL" });
}

function reportConfig(state: ExtensionState, result: ConfigResult): void {
	for (const warning of result.warnings) warnOnce(state, warning);
	if (result.error) {
		warnOnce(
			state,
			`${result.error.message} ${result.error.details.diagnostics?.join("; ") ?? ""}`.trim(),
		);
	}
}

async function loadSessionConfig(
	state: ExtensionState,
	ctx: ExtensionContext,
	force = false,
): Promise<ConfigResult> {
	if (force || !state.configPromise) {
		state.configPromise = loadConfig({
			cwd: ctx.cwd,
			projectTrusted: ctx.isProjectTrusted(),
		});
	}
	const result = await state.configPromise;
	state.configResult = result;
	reportConfig(state, result);
	return result;
}

function bootstrapCommandSnapshot(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: ExtensionState,
	configResult: ConfigResult,
): void {
	const snapshot = buildSkillSnapshot(
		skillsFromCanonicalCommands(pi, ctx.cwd),
		configResult.config,
		configResult.policy,
	);
	state.snapshot = snapshot;
	state.publicationBlocked = false;
	pruneAuthorizationState(state.authorization, snapshot);
}

function selectedCatalog(
	event: BeforeAgentStartEvent,
	ctx: ExtensionContext,
	snapshot: SkillSnapshot,
): string {
	if (snapshot.config.routing !== "adaptive" || !snapshot.routingIndex) {
		return snapshot.safeCatalog;
	}
	const selection = selectRoutingSkills(
		snapshot.routingIndex,
		buildRoutingQuery(event.prompt, ctx.sessionManager.buildContextEntries()),
	);
	if (selection.fallback) return snapshot.safeCatalog;
	return renderAdaptiveCatalog(
		selection.describedSkills,
		selection.remainingNames,
		{ maxDescriptionCharacters: snapshot.config.maxDescriptionCharacters },
	);
}

function nativeReadTool(
	activeTools: readonly string[],
): NativeSkillReadTool | undefined {
	if (activeTools.includes("read")) return "read";
	if (activeTools.includes("bash")) return "bash";
	return undefined;
}

function failClosedSystemPrompt(
	code:
		| "POLICY_INVALID"
		| "SKILL_TOOL_CONFLICT"
		| "SKILL_PROMPT_INTEGRATION_FAILED",
): string {
	return `${new LazySkillError(code).message} Do not load or invoke skills.`;
}

function handlePromptResult(
	state: ExtensionState,
	result: PromptTransformResult,
	mustFailClosed: boolean,
	failureCode:
		| "POLICY_INVALID"
		| "SKILL_TOOL_CONFLICT"
		| "SKILL_PROMPT_INTEGRATION_FAILED",
): { systemPrompt: string } | undefined {
	if (result.warning) warnOnce(state, result.warning);
	if (result.failure && mustFailClosed) {
		return { systemPrompt: failClosedSystemPrompt(failureCode) };
	}
	if (result.replaced || result.sanitized) {
		return { systemPrompt: result.prompt };
	}
	return undefined;
}

interface PreparePromptInput {
	readonly event: BeforeAgentStartEvent;
	readonly ctx: ExtensionContext;
	readonly pi: ExtensionAPI;
	readonly state: ExtensionState;
}

async function prepareSkillPrompt({
	event,
	ctx,
	pi,
	state,
}: PreparePromptInput): Promise<{ systemPrompt: string } | undefined> {
	const configResult = await loadSessionConfig(state, ctx);
	state.ownership = inspectSkillToolOwnership(pi, OWN_MODULE_PATH);
	let snapshot: SkillSnapshot;
	try {
		snapshot = buildSkillSnapshot(
			event.systemPromptOptions.skills ?? [],
			configResult.config,
			configResult.policy,
		);
	} catch (error) {
		warnOnce(
			state,
			`Atomic skill snapshot construction failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		let failureCode:
			| "POLICY_INVALID"
			| "SKILL_TOOL_CONFLICT"
			| "SKILL_PROMPT_INTEGRATION_FAILED" = "SKILL_PROMPT_INTEGRATION_FAILED";
		if (!configResult.policy.valid) failureCode = "POLICY_INVALID";
		else if (state.ownership.status === "foreign") {
			failureCode = "SKILL_TOOL_CONFLICT";
		}
		return { systemPrompt: failClosedSystemPrompt(failureCode) };
	}
	state.snapshot = snapshot;
	state.publicationBlocked = false;
	pruneAuthorizationState(state.authorization, snapshot);

	const activeTools = pi.getActiveTools();
	const readTool = nativeReadTool(activeTools);
	const restrictive = !snapshot.policy.valid || snapshot.policy.restrictive;
	if (state.ownership.status === "foreign") {
		warnOnce(
			state,
			`The resolved skill tool is owned by ${state.ownership.resolvedSource ?? "an unknown source"}, not ${state.ownership.ownSource}; model skill loading is blocked.`,
		);
		if (!readTool) {
			return restrictive
				? { systemPrompt: failClosedSystemPrompt("SKILL_TOOL_CONFLICT") }
				: undefined;
		}
		const result = replaceCanonicalSkillPrompt(
			event.systemPrompt,
			snapshot.canonicalSkills,
			"",
			readTool,
		);
		return handlePromptResult(state, result, true, "SKILL_TOOL_CONFLICT");
	}

	if (state.ownership.status !== "owned") {
		if (!restrictive) return undefined;
		const result = readTool
			? replaceCanonicalSkillPrompt(
					event.systemPrompt,
					snapshot.canonicalSkills,
					"",
					readTool,
				)
			: replaceOrAppendCanonicalSkillCatalog(
					event.systemPrompt,
					snapshot.canonicalSkills,
					"",
				);
		return handlePromptResult(
			state,
			result,
			true,
			snapshot.policy.valid ? "SKILL_PROMPT_INTEGRATION_FAILED" : "POLICY_INVALID",
		);
	}

	const catalog = selectedCatalog(event, ctx, snapshot);
	if (!readTool) {
		return handlePromptResult(
			state,
			replaceOrAppendCanonicalSkillCatalog(
				event.systemPrompt,
				snapshot.canonicalSkills,
				catalog,
			),
			restrictive,
			snapshot.policy.valid ? "SKILL_PROMPT_INTEGRATION_FAILED" : "POLICY_INVALID",
		);
	}
	return handlePromptResult(
		state,
		replaceCanonicalSkillPrompt(
			event.systemPrompt,
			snapshot.canonicalSkills,
			catalog,
			readTool,
		),
		restrictive,
		snapshot.policy.valid ? "SKILL_PROMPT_INTEGRATION_FAILED" : "POLICY_INVALID",
	);
}

export default function lazySkillTool(pi: ExtensionAPI): void {
	const initialConfig = readConfig();
	for (const warning of initialConfig.warnings) {
		process.emitWarning(warning, { code: "PI_LAZY_SKILL_TOOL" });
	}
	if (initialConfig.config.disabled) return;

	const ownSource = canonicalComparisonPath(OWN_MODULE_PATH);
	const state: ExtensionState = {
		ownership: { status: "missing", active: false, ownSource },
		authorization: createAuthorizationState(),
		warnedConditions: new Set(initialConfig.warnings),
		publicationBlocked: true,
		autocompleteInstalled: false,
	};

	pi.registerTool({
		name: "skill",
		label: "Skill",
		description: TOOL_DESCRIPTION,
		promptSnippet: TOOL_PROMPT_SNIPPET,
		promptGuidelines: [TOOL_GUIDELINE],
		parameters: PARAMETERS,
		async execute(toolCallId, params: SkillToolParams, signal, _onUpdate, ctx) {
			const snapshot = state.publicationBlocked ? undefined : state.snapshot;
			const ownership = state.ownership;
			if (!snapshot) throw new LazySkillError("POLICY_INVALID");
			const skill = await authorizeModelExecution(
				toolCallId,
				params.name,
				ctx,
				snapshot,
				state.authorization,
				ownership,
			);
			const loaded = await loadSkill(
				skill,
				snapshot.config.resourceFileSampleLimit,
				signal,
				params.offset ?? 1,
				params.column ?? 1,
				snapshot.config.maxSourceBytes,
			);
			return toolResult({
				snapshot,
				skill,
				body: loaded.body,
				bodyOffset: loaded.bodyOffset,
				bodyColumn: loaded.bodyColumn,
				bodyTruncation: loaded.bodyTruncation,
				nextOffset: loaded.nextOffset,
				nextColumn: loaded.nextColumn,
				files: loaded.relatedFiles.files,
				filesTruncated: loaded.relatedFiles.truncated,
				directoriesVisited: loaded.relatedFiles.directoriesVisited,
			});
		},
	});

	registerLazySkillCommand(pi, () =>
		state.publicationBlocked ? undefined : state.snapshot,
	);

	pi.on("session_start", async (_event, ctx) => {
		resetAuthorizationState(state.authorization);
		state.publicationBlocked = true;
		state.configPromise = undefined;
		const configResult = await loadSessionConfig(state, ctx, true);
		try {
			bootstrapCommandSnapshot(pi, ctx, state, configResult);
		} catch (error) {
			state.publicationBlocked = true;
			warnOnce(
				state,
				`Canonical command snapshot construction failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		state.ownership = inspectSkillToolOwnership(pi, OWN_MODULE_PATH);
		if (!state.autocompleteInstalled) {
			installLazySkillAutocomplete(ctx, pi, () =>
				state.publicationBlocked ? undefined : state.snapshot,
			);
			state.autocompleteInstalled = true;
		}
	});

	pi.on("before_agent_start", (event, ctx) =>
		prepareSkillPrompt({ event, ctx, pi, state }),
	);

	pi.on("tool_call", (event, ctx) =>
		authorizeModelToolCall(
			event,
			ctx,
			state.publicationBlocked ? undefined : state.snapshot,
			state.authorization,
			state.ownership,
		),
	);

	pi.on("input", async (event, ctx) => {
		const invocation = parseExplicitSkillInvocation(event.text);
		if (!invocation) {
			clearPendingExplicitAuthorizations(state.authorization);
			return { action: "continue" as const };
		}
		if (ctx.isIdle()) clearPendingExplicitAuthorizations(state.authorization);
		if (!canonicalSkillCommands(pi).has(invocation.name)) {
			ctx.ui.notify(new LazySkillError("SKILL_NOT_FOUND").message, "error");
			return { action: "handled" as const };
		}
		const configResult =
			state.configResult ?? (await loadSessionConfig(state, ctx));
		try {
			// Commands can change after session_start when extensions contribute resources.
			// Rebuild this explicit-command snapshot from Pi's live registry; the next
			// before_agent_start publishes the richer canonical skill snapshot atomically.
			bootstrapCommandSnapshot(pi, ctx, state, configResult);
			await authorizeExplicitInvocation(
				invocation,
				ctx,
				state.publicationBlocked ? undefined : state.snapshot,
				state.authorization,
			);
			return transformAuthorizedInput(event, invocation);
		} catch (error) {
			const failure =
				error instanceof LazySkillError
					? error
					: new LazySkillError("SKILL_UNREADABLE", { cause: error });
			ctx.ui.notify(failure.message, "error");
			return { action: "handled" as const };
		}
	});

	pi.on("context", (event, ctx) =>
		guardSkillContext(
			event,
			ctx,
			state.publicationBlocked ? undefined : state.snapshot,
			state.authorization,
		),
	);

	pi.on("session_shutdown", () => {
		resetAuthorizationState(state.authorization);
		state.snapshot = undefined;
		state.configResult = undefined;
		state.configPromise = undefined;
		state.publicationBlocked = true;
		state.autocompleteInstalled = false;
	});
}

export type {
	ConfigResult,
	LazySkillConfig,
	SkillRoutingMode,
} from "./config.ts";
export type { RuntimeSkill } from "./catalog.ts";
export type {
	CompiledSkillPolicy,
	SkillPermissionAction,
	SkillPermissionConfig,
	SkillPermissionRule,
} from "./policy.ts";
export type { LazySkillErrorCode } from "./errors.ts";
export {
	LazySkillError,
	isLazySkillError,
	lazySkillErrorMessage,
} from "./errors.ts";
export {
	buildRegistry,
	readConfig,
	renderAdaptiveCatalog,
	renderCompactCatalog,
	renderSafeCatalog,
	userInvokableSkills,
	visibleSkills,
} from "./catalog.ts";
export { loadConfig, parseConfigText } from "./config.ts";
export {
	loadSkill,
	MAX_SKILL_BYTES,
	MAX_SKILL_LINES,
	readValidatedSkillBody,
} from "./loader.ts";
export { sampleRelatedFiles } from "./files.ts";
export {
	appendCanonicalSkillCatalog,
	appendSkillCatalog,
	replaceCanonicalSkillPrompt,
	replaceOrAppendCanonicalSkillCatalog,
	transformSkillPrompt,
} from "./prompt.ts";
export {
	compileSkillPolicy,
	invalidSkillPolicy,
} from "./policy.ts";
export {
	buildRoutingIndex,
	buildRoutingQuery,
	selectRoutingSkills,
} from "./routing.ts";
export type {
	RoutingEvidence,
	RoutingIndex,
	RoutingQuery,
	RoutingSelection,
} from "./routing.ts";
export { buildSkillSnapshot } from "./snapshot.ts";
export type { SkillSnapshot } from "./snapshot.ts";
export {
	canonicalComparisonPath,
	inspectSkillToolOwnership,
} from "./tool-ownership.ts";
