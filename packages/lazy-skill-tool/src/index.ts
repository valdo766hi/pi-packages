import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { relative } from "node:path";
import { Type, type Static } from "typebox";
import {
	buildRegistry,
	readConfig,
	visibleSkills,
	type LazySkillConfig,
	type RuntimeSkill,
} from "./catalog.ts";
import { loadSkill } from "./loader.ts";
import { appendSkillCatalog, transformSkillPrompt } from "./prompt.ts";
import {
	buildRoutingIndex,
	buildRoutingQuery,
	selectRoutingSkills,
	type RoutingIndex,
} from "./routing.ts";

const TOOL_DESCRIPTION = "Load skill; next offset/column continues.";

const PARAMETERS = Type.Object(
	{
		name: Type.String({
			minLength: 1,
		}),
		offset: Type.Optional(Type.Integer({ minimum: 1 })),
		column: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);

type SkillToolParams = Static<typeof PARAMETERS>;

interface ToolResultInput {
	readonly skill: RuntimeSkill;
	readonly body: string;
	readonly bodyOffset: number;
	readonly bodyColumn: number;
	readonly bodyTruncation: TruncationResult;
	readonly nextOffset?: number;
	readonly nextColumn?: number;
	readonly files: readonly string[];
	readonly truncated: boolean;
	readonly directoriesVisited: number;
}

interface SkillToolDetails {
	readonly name: string;
	readonly baseDir: string;
	readonly fileCount: number;
	readonly truncated: boolean;
	readonly directoriesVisited: number;
	readonly bodyOffset: number;
	readonly bodyColumn: number;
	readonly bodyTruncated: boolean;
	nextOffset?: number;
	nextColumn?: number;
}

interface ExtensionState {
	activeRegistry: ReadonlyMap<string, RuntimeSkill>;
	indexedFingerprint: string;
	routingIndex: RoutingIndex;
	readonly loggedPromptWarnings: Set<string>;
}

function routingFingerprint(skills: readonly RuntimeSkill[]): string {
	return JSON.stringify(
		skills.map((skill) => [
			skill.name,
			skill.description,
			skill.filePath,
			skill.baseDir,
			skill.disableModelInvocation,
		]),
	);
}

function toolResult({
	skill,
	body,
	bodyOffset,
	bodyColumn,
	bodyTruncation,
	nextOffset,
	nextColumn,
	files,
	truncated,
	directoriesVisited,
}: ToolResultInput) {
	const context: {
		base: string;
		fileFromBase: string;
		next?: { offset: number; column?: number };
		filesFromBase?: string[];
		filesTruncated?: true;
	} = {
		base: skill.baseDir,
		fileFromBase: relative(skill.baseDir, skill.filePath),
	};
	if (nextOffset !== undefined) {
		context.next = { offset: nextOffset };
		if (nextColumn !== undefined && nextColumn > 1) {
			context.next.column = nextColumn;
		}
	}
	if (files.length > 0) {
		context.filesFromBase = files.map((file) => relative(skill.baseDir, file));
	}
	if (truncated) context.filesTruncated = true;

	const details: SkillToolDetails = {
		name: skill.name,
		baseDir: skill.baseDir,
		fileCount: files.length,
		truncated,
		directoriesVisited,
		bodyOffset,
		bodyColumn,
		bodyTruncated: bodyTruncation.truncated,
	};
	if (nextOffset !== undefined) {
		details.nextOffset = nextOffset;
		details.nextColumn = nextColumn ?? 1;
	}
	return {
		content: [
			{ type: "text" as const, text: body },
			{ type: "text" as const, text: JSON.stringify(context) },
		],
		details,
	};
}

interface PreparePromptInput {
	readonly event: BeforeAgentStartEvent;
	readonly ctx: ExtensionContext;
	readonly config: LazySkillConfig;
	readonly state: ExtensionState;
}

function prepareSkillPrompt(input: PreparePromptInput) {
	const nextRegistry = buildRegistry(input.event.systemPromptOptions.skills ?? []);
	input.state.activeRegistry = nextRegistry;
	const selectedTools = input.event.systemPromptOptions.selectedTools;
	if (selectedTools !== undefined && !selectedTools.includes("skill")) return;

	const skills = visibleSkills(nextRegistry);
	const fingerprint = routingFingerprint(skills);
	if (fingerprint !== input.state.indexedFingerprint) {
		input.state.indexedFingerprint = fingerprint;
		input.state.routingIndex = buildRoutingIndex(skills);
	}
	const selection =
		input.config.routing === "full"
			? undefined
			: selectRoutingSkills(
					input.state.routingIndex,
					buildRoutingQuery(
						input.event.prompt,
						input.ctx.sessionManager.buildContextEntries(),
					),
				);
	const result =
		selectedTools === undefined || selectedTools.includes("read")
			? transformSkillPrompt(
					input.event.systemPrompt,
					skills,
					input.config,
					selection,
				)
			: appendSkillCatalog(
					input.event.systemPrompt,
					skills,
					input.config,
					selection,
				);
	if (
		result.warning &&
		!input.state.loggedPromptWarnings.has(result.warning)
	) {
		input.state.loggedPromptWarnings.add(result.warning);
		process.emitWarning(result.warning, { code: "PI_LAZY_SKILL_TOOL" });
	}
	if (!result.replaced) return;
	return { systemPrompt: result.prompt };
}

export default function lazySkillTool(pi: ExtensionAPI): void {
	const { config, warnings } = readConfig();
	for (const warning of warnings) {
		process.emitWarning(warning, { code: "PI_LAZY_SKILL_TOOL" });
	}

	if (config.disabled) return;

	const state: ExtensionState = {
		activeRegistry: new Map(),
		indexedFingerprint: "",
		routingIndex: buildRoutingIndex([]),
		loggedPromptWarnings: new Set(),
	};

	pi.registerTool({
		name: "skill",
		label: "Skill",
		description: TOOL_DESCRIPTION,
		parameters: PARAMETERS,
		async execute(
			_toolCallId: string,
			params: SkillToolParams,
			signal: AbortSignal | undefined,
		) {
			const registry = state.activeRegistry;
			const skill = registry.get(params.name);
			if (!skill || skill.disableModelInvocation) {
				throw new Error(`Skill "${params.name}" is not available.`);
			}

			const loaded = await loadSkill(
				skill,
				config.fileLimit,
				signal,
				params.offset ?? 1,
				params.column ?? 1,
			);
			return toolResult({
				skill,
				body: loaded.body,
				bodyOffset: loaded.bodyOffset,
				bodyColumn: loaded.bodyColumn,
				bodyTruncation: loaded.bodyTruncation,
				nextOffset: loaded.nextOffset,
				nextColumn: loaded.nextColumn,
				files: loaded.relatedFiles.files,
				truncated: loaded.relatedFiles.truncated,
				directoriesVisited: loaded.relatedFiles.directoriesVisited,
			});
		},
	});

	pi.on("before_agent_start", (event, ctx) =>
		prepareSkillPrompt({ event, ctx, config, state }),
	);
}

export type {
	LazySkillConfig,
	RuntimeSkill,
	SkillRoutingMode,
} from "./catalog.ts";
export {
	buildRegistry,
	readConfig,
	renderCompactCatalog,
	visibleSkills,
} from "./catalog.ts";
export { loadSkill, MAX_SKILL_BYTES } from "./loader.ts";
export { sampleRelatedFiles } from "./files.ts";
export { appendSkillCatalog, transformSkillPrompt } from "./prompt.ts";
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
