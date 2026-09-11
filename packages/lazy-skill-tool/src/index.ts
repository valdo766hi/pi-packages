import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	Skill,
	TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "typebox";
import {
	authorizeExplicitInvocation,
	authorizeModelExecution,
	authorizeModelToolCall,
	assertLiveSkillAccess,
	clearPendingExplicitAuthorizations,
	createAuthorizationState,
	guardSkillContext,
	invalidateOneTimeTickets,
	parseExplicitSkillInvocation,
	pruneAuthorizationState,
	resetAuthorizationState,
	transformAuthorizedInput,
	type SkillAuthorizationState,
} from "./authorization.ts";
import {
	STABLE_ADAPTIVE_INSTRUCTIONS,
	type RuntimeSkill,
} from "./catalog.ts";
import { loadConfig, readConfig, type ConfigResult } from "./config.ts";
import { LazySkillError } from "./errors.ts";
import { loadSkill } from "./loader.ts";
import {
	failClosedHostPrompt,
	replaceCanonicalSkillPrompt,
	replaceOrAppendCanonicalSkillCatalog,
	renderDisclosureCatalog,
	routingHintMessage,
	type NativeSkillReadTool,
	type PromptTransformResult,
} from "./prompt.ts";
import {
	buildRoutingQuery,
	discloseAdaptiveCatalog,
} from "./routing.ts";
import { renderSearchPage, searchSkills } from "./search.ts";
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
const SEARCH_DESCRIPTION =
	"Search or browse policy-visible skill metadata; paginate with cursor.";
const SEARCH_PROMPT_SNIPPET =
	"Discover skill metadata by search or browse";
const SEARCH_GUIDELINE =
	"Candidates are suggestions, not an exhaustive catalog. Search when they do not cover the task, when the task changes, or before concluding that no suitable skill exists.";
const OWN_MODULE_PATH = fileURLToPath(import.meta.url);

const PARAMETERS = Type.Object(
	{
		name: Type.String({ minLength: 1 }),
		offset: Type.Optional(Type.Integer({ minimum: 1 })),
		column: Type.Optional(Type.Integer({ minimum: 1 })),
		rev: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

const SEARCH_PARAMETERS = Type.Object(
	{
		query: Type.Optional(Type.String()),
		cursor: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

type SkillToolParams = Static<typeof PARAMETERS>;
type SkillSearchParams = Static<typeof SEARCH_PARAMETERS>;

interface ToolResultInput {
	readonly snapshot: SkillSnapshot;
	readonly skill: RuntimeSkill;
	readonly body: string;
	readonly bodyOffset: number;
	readonly bodyColumn: number;
	readonly bodyTruncation: TruncationResult;
	readonly sourceRevision: string;
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
	readonly sourceRevision: string;
}

interface ExtensionState {
	status: "ready" | "blocked";
	snapshot?: SkillSnapshot;
	configResult?: ConfigResult;
	configPromise?: Promise<ConfigResult>;
	ownership: SkillToolOwnership;
	readonly authorization: SkillAuthorizationState;
	readonly warnedConditions: Set<string>;
	cancelProviderRequest: boolean;
	autocompleteInstalled: boolean;
}

function toolResult({
	snapshot,
	skill,
	body,
	bodyOffset,
	bodyColumn,
	bodyTruncation,
	sourceRevision,
	nextOffset,
	nextColumn,
	files,
	filesTruncated,
	directoriesVisited,
}: ToolResultInput) {
	const context: {
		base: string;
		next?: { offset: number; column: number; rev: string };
		resources?: string[];
		resourcesTruncated?: true;
	} = { base: skill.baseDir };
	if (nextOffset !== undefined) {
		context.next = {
			offset: nextOffset,
			column: nextColumn ?? 1,
			rev: sourceRevision,
		};
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
		sourceRevision,
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

function publishedSnapshot(state: ExtensionState): SkillSnapshot | undefined {
	return state.status === "ready" ? state.snapshot : undefined;
}

function publishSnapshot(state: ExtensionState, snapshot: SkillSnapshot): void {
	state.snapshot = snapshot;
	state.status = "ready";
	state.cancelProviderRequest = false;
	pruneAuthorizationState(state.authorization, snapshot);
}

function blockPublication(state: ExtensionState): void {
	state.status = "blocked";
	state.snapshot = undefined;
	state.cancelProviderRequest = true;
	invalidateOneTimeTickets(state.authorization);
}

function cancelUnsafeRequest(ctx: ExtensionContext, state: ExtensionState): void {
	if (!state.cancelProviderRequest) return;
	ctx.abort();
}

function bootstrapCommandSnapshot(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: ExtensionState,
	configResult: ConfigResult,
): void {
	if (state.cancelProviderRequest || !configResult.policy.valid) return;
	const snapshot = buildSkillSnapshot(
		skillsFromCanonicalCommands(pi, ctx.cwd),
		configResult.config,
		configResult.policy,
	);
	if (!snapshot.policy.valid) return;
	publishSnapshot(state, snapshot);
}

function adaptiveDisclosure(
	event: BeforeAgentStartEvent,
	ctx: ExtensionContext,
	snapshot: SkillSnapshot,
) {
	const explicit = parseExplicitSkillInvocation(event.prompt);
	return discloseAdaptiveCatalog({
		index: snapshot.routingIndex ?? {
			documents: [],
			documentFrequency: new Map(),
			averageDocumentLength: 0,
		},
		query: buildRoutingQuery(
			event.prompt,
			ctx.sessionManager.buildContextEntries(),
		),
		modelVisible: snapshot.modelVisible,
		safeCatalog: snapshot.safeCatalog,
		safeCatalogTokens: snapshot.safeCatalogTokens,
		catalogTokenBudget: snapshot.config.catalogTokenBudget,
		...(explicit ? { explicitName: explicit.name } : {}),
	});
}

function nativeReadTool(
	activeTools: readonly string[],
): NativeSkillReadTool | undefined {
	if (activeTools.includes("read")) return "read";
	if (activeTools.includes("bash")) return "bash";
	return undefined;
}

type FailClosedCode =
	| "POLICY_INVALID"
	| "SKILL_TOOL_CONFLICT"
	| "SKILL_PROMPT_INTEGRATION_FAILED";

function failClosedResult(
	event: BeforeAgentStartEvent,
	ctx: ExtensionContext,
	state: ExtensionState,
	canonicalSkills: readonly Skill[],
	readTool: NativeSkillReadTool | undefined,
	code: FailClosedCode,
): { systemPrompt: string } {
	blockPublication(state);
	ctx.abort();
	return {
		systemPrompt: failClosedHostPrompt(
			event.systemPrompt,
			canonicalSkills,
			code,
			readTool,
		).prompt,
	};
}

function handlePromptResult(
	state: ExtensionState,
	snapshot: SkillSnapshot,
	result: PromptTransformResult,
	mustFailClosed: boolean,
	failureCode: FailClosedCode,
	event: BeforeAgentStartEvent,
	ctx: ExtensionContext,
	readTool: NativeSkillReadTool | undefined,
	message?: ReturnType<typeof routingHintMessage>,
):
	| { systemPrompt?: string; message?: ReturnType<typeof routingHintMessage> }
	| undefined {
	if (result.warning) warnOnce(state, result.warning);
	if (result.failure && mustFailClosed) {
		return failClosedResult(
			event,
			ctx,
			state,
			snapshot.canonicalSkills,
			readTool,
			failureCode,
		);
	}
	if (result.failure) return undefined;
	publishSnapshot(state, snapshot);
	if (result.replaced || result.sanitized) {
		return {
			systemPrompt: result.prompt,
			...(message === undefined ? {} : { message }),
		};
	}
	if (message) return { message };
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
}: PreparePromptInput): Promise<
	| { systemPrompt?: string; message?: ReturnType<typeof routingHintMessage> }
	| undefined
> {
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
		let failureCode: FailClosedCode = "SKILL_PROMPT_INTEGRATION_FAILED";
		if (!configResult.policy.valid) failureCode = "POLICY_INVALID";
		else if (state.ownership.status === "foreign") {
			failureCode = "SKILL_TOOL_CONFLICT";
		}
		return failClosedResult(
			event,
			ctx,
			state,
			event.systemPromptOptions.skills ?? [],
			nativeReadTool(pi.getActiveTools()),
			failureCode,
		);
	}

	if (!snapshot.policy.valid) {
		return failClosedResult(
			event,
			ctx,
			state,
			snapshot.canonicalSkills,
			nativeReadTool(pi.getActiveTools()),
			"POLICY_INVALID",
		);
	}

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
				? failClosedResult(
						event,
						ctx,
						state,
						snapshot.canonicalSkills,
						readTool,
						"SKILL_TOOL_CONFLICT",
					)
				: undefined;
		}
		const result = replaceCanonicalSkillPrompt(
			event.systemPrompt,
			snapshot.canonicalSkills,
			"",
			readTool,
		);
		return handlePromptResult(
			state,
			snapshot,
			result,
			true,
			"SKILL_TOOL_CONFLICT",
			event,
			ctx,
			readTool,
		);
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
			snapshot,
			result,
			true,
			snapshot.policy.valid ? "SKILL_PROMPT_INTEGRATION_FAILED" : "POLICY_INVALID",
			event,
			ctx,
			readTool,
		);
	}

	const adaptive =
		snapshot.config.routing === "adaptive" && snapshot.modelVisible.length > 0;
	const disclosure = adaptive ? adaptiveDisclosure(event, ctx, snapshot) : undefined;
	const catalog = adaptive
		? STABLE_ADAPTIVE_INSTRUCTIONS
		: snapshot.safeCatalog;
	const message =
		adaptive && disclosure
			? routingHintMessage(
					renderDisclosureCatalog(disclosure, {
						maxDescriptionCharacters: snapshot.config.maxDescriptionCharacters,
					}),
					{
						strategy: disclosure.strategy,
						reason: disclosure.reason,
						describedCount: disclosure.describedSkills.length,
						remainingCount: disclosure.remainingNames.length,
						estimatedTokens: disclosure.estimatedTokens,
						incomplete: disclosure.incomplete,
					},
				)
			: undefined;
	if (!readTool) {
		return handlePromptResult(
			state,
			snapshot,
			replaceOrAppendCanonicalSkillCatalog(
				event.systemPrompt,
				snapshot.canonicalSkills,
				catalog,
			),
			restrictive,
			snapshot.policy.valid ? "SKILL_PROMPT_INTEGRATION_FAILED" : "POLICY_INVALID",
			event,
			ctx,
			readTool,
			message,
		);
	}
	return handlePromptResult(
		state,
		snapshot,
		replaceCanonicalSkillPrompt(
			event.systemPrompt,
			snapshot.canonicalSkills,
			catalog,
			readTool,
		),
		restrictive,
		snapshot.policy.valid ? "SKILL_PROMPT_INTEGRATION_FAILED" : "POLICY_INVALID",
		event,
		ctx,
		readTool,
		message,
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
		status: "blocked",
		ownership: { status: "missing", active: false, ownSource },
		authorization: createAuthorizationState(),
		warnedConditions: new Set(initialConfig.warnings),
		cancelProviderRequest: false,
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
			const snapshot = publishedSnapshot(state);
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
				params.rev,
			);
			assertLiveSkillAccess(
				publishedSnapshot(state),
				snapshot,
				params.name,
				true,
			);
			return toolResult({
				snapshot,
				skill,
				body: loaded.body,
				bodyOffset: loaded.bodyOffset,
				bodyColumn: loaded.bodyColumn,
				bodyTruncation: loaded.bodyTruncation,
				sourceRevision: loaded.sourceRevision,
				nextOffset: loaded.nextOffset,
				nextColumn: loaded.nextColumn,
				files: loaded.relatedFiles.files,
				filesTruncated: loaded.relatedFiles.truncated,
				directoriesVisited: loaded.relatedFiles.directoriesVisited,
			});
		},
	});

	pi.registerTool({
		name: "skill_search",
		label: "Skill Search",
		description: SEARCH_DESCRIPTION,
		promptSnippet: SEARCH_PROMPT_SNIPPET,
		promptGuidelines: [SEARCH_GUIDELINE],
		parameters: SEARCH_PARAMETERS,
		async execute(_toolCallId, params: SkillSearchParams, _signal, _onUpdate, _ctx) {
			const snapshot = publishedSnapshot(state);
			if (!snapshot) throw new LazySkillError("POLICY_INVALID");
			if (state.ownership.status !== "owned") {
				throw new LazySkillError("SKILL_TOOL_CONFLICT");
			}
			const page = searchSkills(snapshot, params);
			const skills = page.skills.flatMap((hit) => {
				const skill = snapshot.byName.get(hit.name);
				return skill ? [skill] : [];
			});
			const live = publishedSnapshot(state);
			if (!live || live.fingerprint !== snapshot.fingerprint) {
				throw new LazySkillError("POLICY_INVALID");
			}
			return {
				content: [
					{ type: "text" as const, text: renderSearchPage(page, skills) },
					{
						type: "text" as const,
						text: JSON.stringify({
							mode: page.mode,
							hasMore: page.hasMore,
							weak: page.weak,
							total: page.total,
							...(page.nextCursor === undefined
								? {}
								: { nextCursor: page.nextCursor }),
						}),
					},
				],
				details: {
					snapshotFingerprint: snapshot.fingerprint,
					mode: page.mode,
					offset: page.offset,
					total: page.total,
					weak: page.weak,
				},
			};
		},
	});

	registerLazySkillCommand(pi, () => publishedSnapshot(state));

	pi.on("session_start", async (_event, ctx) => {
		resetAuthorizationState(state.authorization);
		blockPublication(state);
		state.cancelProviderRequest = false;
		state.configPromise = undefined;
		const configResult = await loadSessionConfig(state, ctx, true);
		try {
			bootstrapCommandSnapshot(pi, ctx, state, configResult);
		} catch (error) {
			blockPublication(state);
			warnOnce(
				state,
				`Canonical command snapshot construction failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		state.ownership = inspectSkillToolOwnership(pi, OWN_MODULE_PATH);
		if (!state.autocompleteInstalled) {
			installLazySkillAutocomplete(ctx, pi, () => publishedSnapshot(state));
			state.autocompleteInstalled = true;
		}
	});

	pi.on("before_agent_start", (event, ctx) =>
		prepareSkillPrompt({ event, ctx, pi, state }),
	);

	pi.on("agent_start", (_event, ctx) => cancelUnsafeRequest(ctx, state));
	pi.on("turn_start", (_event, ctx) => cancelUnsafeRequest(ctx, state));
	pi.on("before_provider_request", (_event, ctx) => {
		cancelUnsafeRequest(ctx, state);
		return undefined;
	});

	pi.on("tool_call", (event, ctx) =>
		authorizeModelToolCall(
			event,
			ctx,
			publishedSnapshot(state),
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
			bootstrapCommandSnapshot(pi, ctx, state, configResult);
			await authorizeExplicitInvocation(
				invocation,
				ctx,
				publishedSnapshot(state),
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

	pi.on("context", async (event, ctx) => {
		cancelUnsafeRequest(ctx, state);
		return guardSkillContext(
			event,
			ctx,
			publishedSnapshot(state),
			state.authorization,
		);
	});

	pi.on("session_shutdown", () => {
		resetAuthorizationState(state.authorization);
		blockPublication(state);
		state.configResult = undefined;
		state.configPromise = undefined;
		state.cancelProviderRequest = false;
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
	discloseAdaptiveCatalog,
	safeLoadTargets,
	selectRoutingSkills,
} from "./routing.ts";
export type {
	AdaptiveDisclosure,
	DisclosureStrategy,
	RoutingEvidence,
	RoutingIndex,
	RoutingQuery,
	RoutingSelection,
} from "./routing.ts";
export { searchSkills, renderSearchPage } from "./search.ts";
export { skillSourceRevision } from "./loader.ts";
export { buildSkillSnapshot } from "./snapshot.ts";
export type { SkillSnapshot } from "./snapshot.ts";
export {
	canonicalComparisonPath,
	inspectSkillToolOwnership,
} from "./tool-ownership.ts";
