import type {
	ExtensionAPI,
	ExtensionContext,
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
	"Load a specialized skill when the task matches a skill listed in <available_skills>. Use the exact skill name. The tool returns the complete skill instructions, base directory, and sampled related resources.";

const PARAMETERS = Type.Object(
	{
		name: Type.String({
			description: "Exact skill name from available_skills",
			minLength: 1,
		}),
	},
	{ additionalProperties: false },
);

type SkillToolParams = Static<typeof PARAMETERS>;

interface ToolResultInput {
	readonly skill: RuntimeSkill;
	readonly body: string;
	readonly files: readonly string[];
	readonly truncated: boolean;
}

function toolResult({ skill, body, files, truncated }: ToolResultInput) {
	const fileLines = files.map((file) => `  <file>${escapeXml(file)}</file>`);
	const sampled = truncated || files.length > 0;
	const safeBody = body.replaceAll("]]>", "]]]]><![CDATA[>");
	const text = [
		`<skill_content name="${escapeXml(skill.name)}">`,
		`# Skill: ${escapeXml(skill.name)}`,
		"",
		"<skill_body><![CDATA[",
		safeBody,
		"]]></skill_body>",
		"",
		`Base directory for this skill: ${escapeXml(skill.baseDir)}`,
		"Relative paths referenced by this skill are relative to this base directory.",
		`Note: related file list is sampled${sampled ? "." : " and empty."}`,
		"",
		`<skill_files sampled="${sampled ? "true" : "false"}">`,
		...fileLines,
		"</skill_files>",
		"</skill_content>",
	].join("\n");

	return {
		content: [{ type: "text" as const, text }],
		details: {
			name: skill.name,
			baseDir: skill.baseDir,
			fileCount: files.length,
			truncated,
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
	let promptWarningLogged = false;

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

			const loaded = await loadSkill(skill, config.fileLimit, signal);
			return toolResult({
				skill,
				body: loaded.body,
				files: loaded.relatedFiles.files,
				truncated: loaded.relatedFiles.truncated,
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
		if (result.warning && !promptWarningLogged) {
			promptWarningLogged = true;
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
