import type { Skill } from "@earendil-works/pi-coding-agent";
import { isAbsolute } from "node:path";

export const DEFAULT_DESCRIPTION_MAX = 240;
export const DEFAULT_FILE_LIMIT = 10;
const MAX_DESCRIPTION_MAX = 1024;
const MAX_FILE_LIMIT = 50;

export interface LazySkillConfig {
	readonly descriptionMax: number;
	readonly fileLimit: number;
	readonly disabled: boolean;
}

export interface ConfigResult {
	readonly config: LazySkillConfig;
	readonly warnings: readonly string[];
}

export interface RuntimeSkill {
	readonly name: string;
	readonly description: string;
	readonly filePath: string;
	readonly baseDir: string;
	readonly disableModelInvocation: boolean;
}

function parseBoundedInteger(
	env: NodeJS.ProcessEnv,
	key: string,
	min: number,
	max: number,
	fallback: number,
	warnings: string[],
): number {
	const raw = env[key];
	if (raw === undefined) return fallback;

	const value = Number(raw.trim());
	if (!Number.isInteger(value) || value < min || value > max) {
		warnings.push(
			`${key} must be an integer from ${min} to ${max}; using ${fallback}.`,
		);
		return fallback;
	}
	return value;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ConfigResult {
	const warnings: string[] = [];
	return {
		config: {
			descriptionMax: parseBoundedInteger(
				env,
				"PI_LAZY_SKILL_DESCRIPTION_MAX",
				0,
				MAX_DESCRIPTION_MAX,
				DEFAULT_DESCRIPTION_MAX,
				warnings,
			),
			fileLimit: parseBoundedInteger(
				env,
				"PI_LAZY_SKILL_FILE_LIMIT",
				0,
				MAX_FILE_LIMIT,
				DEFAULT_FILE_LIMIT,
				warnings,
			),
			disabled: /^(1|true|yes)$/i.test(env.PI_LAZY_SKILL_DISABLE ?? ""),
		},
		warnings,
	};
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
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

		// Pi already resolves collisions. Keep the first entry if a malformed
		// or synthetic snapshot contains a duplicate anyway.
		if (registry.has(skill.name)) continue;

		registry.set(skill.name, {
			name: skill.name,
			description: skill.description,
			filePath: skill.filePath,
			baseDir: skill.baseDir,
			disableModelInvocation: skill.disableModelInvocation === true,
		});
	}

	return registry;
}

export function visibleSkills(
	registry: ReadonlyMap<string, RuntimeSkill>,
): RuntimeSkill[] {
	return [...registry.values()]
		.filter((skill) => !skill.disableModelInvocation)
		.sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeDescription(description: string): string {
	return description.replace(/\s+/gu, " ").trim();
}

export function compactDescription(description: string, max: number): string {
	const normalized = normalizeDescription(description);
	const characters = [...normalized];
	if (max === 0 || characters.length <= max) return normalized;

	const ellipsis = "…";
	const budget = max - ellipsis.length;
	let shortened = characters.slice(0, budget).join("").trimEnd();
	const boundary = shortened.lastIndexOf(" ");
	if (boundary > 0) shortened = shortened.slice(0, boundary).trimEnd();
	return `${shortened}${ellipsis}`;
}

export function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export function renderCompactCatalog(
	skills: readonly RuntimeSkill[],
	config: Pick<LazySkillConfig, "descriptionMax">,
): string {
	const sorted = skills
		.filter((skill) => !skill.disableModelInvocation)
		.toSorted((a, b) => a.name.localeCompare(b.name));

	return [
		"The following skills provide specialized instructions for specific tasks.",
		"When a task matches a skill's description, use the `skill` tool with that exact skill name before proceeding.",
		"When a skill references a relative path, resolve it from the base directory returned by the `skill` tool.",
		"",
		"<available_skills>",
		...sorted.flatMap((skill) => [
			"  <skill>",
			`    <name>${escapeXml(skill.name)}</name>`,
			`    <description>${escapeXml(compactDescription(skill.description, config.descriptionMax))}</description>`,
			"  </skill>",
		]),
		"</available_skills>",
	].join("\n");
}
