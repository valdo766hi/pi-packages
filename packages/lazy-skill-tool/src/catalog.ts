import type { Skill, SourceInfo } from "@earendil-works/pi-coding-agent";
import { isAbsolute } from "node:path";
import { DEFAULT_DESCRIPTION_MAX, type LazySkillConfig } from "./config.ts";
import { immutableMap } from "./immutable.ts";
import { compileSkillPolicy, type CompiledSkillPolicy } from "./policy.ts";

export {
	DEFAULT_DESCRIPTION_MAX,
	DEFAULT_FILE_LIMIT,
	readConfig,
} from "./config.ts";
export type {
	ConfigResult,
	LazySkillConfig,
	SkillRoutingMode,
} from "./config.ts";

export interface RuntimeSkill {
	readonly name: string;
	readonly description: string;
	readonly filePath: string;
	readonly baseDir: string;
	readonly disableModelInvocation: boolean;
	readonly sourceInfo: SourceInfo;
}

interface DescriptionConfig {
	readonly maxDescriptionCharacters?: number;
	/** @deprecated Use maxDescriptionCharacters. */
	readonly descriptionMax?: number;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function compareText(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function compareNames(left: RuntimeSkill, right: RuntimeSkill): number {
	return compareText(left.name, right.name);
}

export function buildRegistry(
	skills: readonly Skill[],
): ReadonlyMap<string, RuntimeSkill> {
	const registry = new Map<string, RuntimeSkill>();
	for (const skill of skills) {
		if (
			!isNonEmptyString(skill.name) ||
			!isNonEmptyString(skill.description) ||
			!isNonEmptyString(skill.filePath) ||
			!isNonEmptyString(skill.baseDir) ||
			!isAbsolute(skill.filePath) ||
			!isAbsolute(skill.baseDir)
		) {
			continue;
		}
		if (registry.has(skill.name)) continue;
		registry.set(
			skill.name,
			Object.freeze({
				name: skill.name,
				description: skill.description,
				filePath: skill.filePath,
				baseDir: skill.baseDir,
				disableModelInvocation: skill.disableModelInvocation === true,
				sourceInfo: Object.freeze({ ...skill.sourceInfo }),
			}),
		);
	}
	return immutableMap(registry);
}

export function visibleSkills(
	registry: ReadonlyMap<string, RuntimeSkill>,
	policy: CompiledSkillPolicy = compileSkillPolicy(),
): RuntimeSkill[] {
	if (!policy.valid) return [];
	return [...registry.values()]
		.filter(
			(skill) =>
				!skill.disableModelInvocation && policy.decision(skill.name) !== "deny",
		)
		.sort(compareNames);
}

export function userInvokableSkills(
	registry: ReadonlyMap<string, RuntimeSkill>,
	policy: CompiledSkillPolicy,
): RuntimeSkill[] {
	if (!policy.valid) return [];
	return [...registry.values()]
		.filter((skill) => policy.decision(skill.name) !== "deny")
		.sort(compareNames);
}

export function normalizeDescription(description: string): string {
	return description.replace(/\s+/gu, " ").trim();
}

function descriptionLimit(config: DescriptionConfig): number {
	const legacy = (config as { readonly descriptionMax?: number }).descriptionMax;
	return config.maxDescriptionCharacters ?? legacy ?? 0;
}

export function compactDescription(
	description: string,
	maximum: number,
): string {
	const normalized = normalizeDescription(description);
	if (maximum === 0) return normalized;
	const characters = [...normalized];
	if (characters.length <= maximum) return normalized;
	const budget = Math.max(0, maximum - 1);
	let shortened = characters.slice(0, budget).join("").trimEnd();
	const boundary = shortened.lastIndexOf(" ");
	if (boundary > 0) shortened = shortened.slice(0, boundary).trimEnd();
	return `${shortened}…`;
}

export function escapeXml(value: string): string {
	return value
		.replace(/&/gu, "&amp;")
		.replace(/</gu, "&lt;")
		.replace(/>/gu, "&gt;")
		.replace(/"/gu, "&quot;")
		.replace(/'/gu, "&apos;");
}

function exactNameAttribute(name: string): string {
	const quoted = JSON.stringify(name);
	return escapeXml(quoted.slice(1, -1));
}

function escapeXmlText(value: string): string {
	return value
		.replace(/&/gu, "&amp;")
		.replace(/</gu, "&lt;")
		.replace(/>/gu, "&gt;");
}

function renderSkillEntries(
	skills: readonly RuntimeSkill[],
	config: DescriptionConfig,
): string[] {
	return skills
		.filter((skill) => !skill.disableModelInvocation)
		.toSorted(compareNames)
		.map(
			(skill) =>
				`<skill name="${exactNameAttribute(skill.name)}">${escapeXmlText(compactDescription(skill.description, descriptionLimit(config)))}</skill>`,
		);
}

export const DISCOVERY_INSTRUCTION =
	"Candidates are suggestions, not an exhaustive catalog. Search when they do not cover the task, when the task changes, or before concluding that no suitable skill exists.";
export const INCOMPLETE_DISCOVERY_INSTRUCTION =
	"Skill discovery is incomplete. Use skill_search to browse remaining policy-visible skills.";
export const ROUTING_MESSAGE_TYPE = "lazy-skill-routing";
export const STABLE_ADAPTIVE_INSTRUCTIONS = [
	"Load specialized instructions with skill by exact name.",
	"When a candidate description matches the task, call skill before taking the dependent action.",
	DISCOVERY_INSTRUCTION,
].join(" ");

export function renderSafeCatalog(
	skills: readonly RuntimeSkill[],
	config: DescriptionConfig = {
		maxDescriptionCharacters: DEFAULT_DESCRIPTION_MAX,
	},
): string {
	const entries = renderSkillEntries(skills, config);
	if (entries.length === 0) return "";
	return ["<available_skills>", ...entries, "</available_skills>"].join("\n");
}

/** @deprecated `full` and renderCompactCatalog are aliases for safe. */
export function renderCompactCatalog(
	skills: readonly RuntimeSkill[],
	config: DescriptionConfig = {
		maxDescriptionCharacters: DEFAULT_DESCRIPTION_MAX,
	},
): string {
	return renderSafeCatalog(skills, config);
}

export function renderAdaptiveCatalog(
	describedSkills: readonly RuntimeSkill[],
	remainingNames: readonly string[],
	config: DescriptionConfig = {
		maxDescriptionCharacters: DEFAULT_DESCRIPTION_MAX,
	},
	incomplete = false,
): string {
	const parts: string[] = [];
	if (remainingNames.length === 0 && !incomplete) {
		const catalog = renderSafeCatalog(describedSkills, config);
		if (catalog) parts.push(catalog);
	} else {
		const catalog = renderSafeCatalog(describedSkills, config);
		if (catalog) parts.push(catalog);
		const names = remainingNames.toSorted(compareText);
		if (names.length > 0) {
			parts.push(
				`<other_skill_names>${escapeXmlText(JSON.stringify(names))}</other_skill_names>`,
			);
		}
	}
	if (incomplete) parts.push(INCOMPLETE_DISCOVERY_INSTRUCTION);
	return parts.filter(Boolean).join("\n");
}

export type CatalogConfig = Pick<LazySkillConfig, "maxDescriptionCharacters">;
