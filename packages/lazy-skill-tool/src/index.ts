import type {
	ExtensionAPI,
	ExtensionContext,
	TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
	buildRegistry,
	escapeXml,
	readConfig,
	visibleSkills,
	type RuntimeSkill,
} from "./catalog.ts";
import { loadSkill } from "./loader.ts";
import { appendSkillCatalog, transformSkillPrompt } from "./prompt.ts";

const TOOL_DESCRIPTION =
	"Load a skill listed in <available_skills> by exact name. Returns its validated SKILL.md and base directory. Use offset and column to continue large content.";

const PARAMETERS = Type.Object(
	{
		name: Type.String({
			description: "Exact available skill name",
			minLength: 1,
		}),
		offset: Type.Optional(
			Type.Integer({
				description: "Skill file line to start from (1-indexed)",
				minimum: 1,
			}),
		),
		column: Type.Optional(
			Type.Integer({
				description: "Character on the offset line (1-indexed)",
				minimum: 1,
			}),
		),
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
	const continuation: string[] = [];
	if (bodyTruncation.truncated && nextOffset !== undefined) {
		const columnArgument =
			nextColumn === undefined || nextColumn === 1 ? "" : `, column=${nextColumn}`;
		continuation.push(
			"",
			`Skill file truncated at Pi's regular ${bodyTruncation.maxLines}-line or ${bodyTruncation.maxBytes}-byte output limit.`,
			`Continue with skill(name="${escapeXml(skill.name)}", offset=${nextOffset}${columnArgument}).`,
		);
	}
	const relatedFiles: string[] = [];
	if (files.length > 0) {
		relatedFiles.push(
			"",
			`<skill_files truncated="${truncated}">`,
			...files.map((file) => `<file>${escapeXml(file)}</file>`),
			"</skill_files>",
		);
	} else if (truncated) {
		relatedFiles.push("", "Related file sampling was incomplete.");
	}
	const context = [
		`<skill_context name="${escapeXml(skill.name)}" offset="${bodyOffset}" column="${bodyColumn}" truncated="${bodyTruncation.truncated}">`,
		...continuation,
		`Skill file: ${escapeXml(skill.filePath)}`,
		`Base directory: ${escapeXml(skill.baseDir)}`,
		"Resolve relative paths from this directory.",
		...relatedFiles,
		"</skill_context>",
	].join("\n");

	return {
		content: [
			{ type: "text" as const, text: body },
			{ type: "text" as const, text: context },
		],
		details: {
			name: skill.name,
			baseDir: skill.baseDir,
			fileCount: files.length,
			truncated,
			directoriesVisited,
			bodyOffset,
			bodyColumn,
			bodyTruncated: bodyTruncation.truncated,
			...(nextOffset === undefined
				? {}
				: { nextOffset, nextColumn: nextColumn ?? 1 }),
		},
	};
}

export default function lazySkillTool(pi: ExtensionAPI): void {
	const { config, warnings } = readConfig();
	for (const warning of warnings) {
		console.warn(`[pi-lazy-skill-tool] ${warning}`);
	}

	if (config.disabled) return;

	let activeRegistry: ReadonlyMap<string, RuntimeSkill> = new Map();
	const loggedPromptWarnings = new Set<string>();

	pi.registerTool({
		name: "skill",
		label: "Skill",
		description: TOOL_DESCRIPTION,
		parameters: PARAMETERS,
		async execute(
			_toolCallId: string,
			params: SkillToolParams,
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_ctx: ExtensionContext,
		) {
			const registry = activeRegistry;
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

	pi.on("before_agent_start", (event) => {
		const nextRegistry = buildRegistry(event.systemPromptOptions.skills ?? []);
		activeRegistry = nextRegistry;

		const selectedTools = event.systemPromptOptions.selectedTools;
		if (selectedTools !== undefined && !selectedTools.includes("skill")) return;

		const skills = visibleSkills(nextRegistry);
		const result =
			selectedTools === undefined || selectedTools.includes("read")
				? transformSkillPrompt(event.systemPrompt, skills, config)
				: appendSkillCatalog(event.systemPrompt, skills, config);
		if (result.warning && !loggedPromptWarnings.has(result.warning)) {
			loggedPromptWarnings.add(result.warning);
			console.warn(`[pi-lazy-skill-tool] ${result.warning}`);
		}
		if (!result.replaced) return;
		return { systemPrompt: result.prompt };
	});
}

export type { LazySkillConfig, RuntimeSkill } from "./catalog.ts";
export {
	buildRegistry,
	readConfig,
	renderCompactCatalog,
	visibleSkills,
} from "./catalog.ts";
export { loadSkill, MAX_SKILL_BYTES } from "./loader.ts";
export { sampleRelatedFiles } from "./files.ts";
export { appendSkillCatalog, transformSkillPrompt } from "./prompt.ts";
