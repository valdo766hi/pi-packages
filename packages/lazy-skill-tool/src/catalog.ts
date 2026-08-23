import type { Skill } from "@earendil-works/pi-coding-agent";
import { isAbsolute } from "node:path";

export const DEFAULT_DESCRIPTION_MAX = 0;
export const DEFAULT_FILE_LIMIT = 0;
const MAX_DESCRIPTION_MAX = 1024;
const MAX_FILE_LIMIT = 50;

export type SkillRoutingMode = "adaptive" | "full";

export interface LazySkillConfig {
	readonly descriptionMax: number;
	readonly fileLimit: number;
	readonly routing: SkillRoutingMode;
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

interface BoundedIntegerOptions {
	readonly env: NodeJS.ProcessEnv;
	readonly key: string;
	readonly min: number;
	readonly max: number;
	readonly fallback: number;
	readonly warnings: string[];
}

function parseBoundedInteger(options: BoundedIntegerOptions): number {
	const raw = options.env[options.key];
	if (raw === undefined) return options.fallback;

	const value = Number(raw.trim());
	if (!Number.isInteger(value) || value < options.min || value > options.max) {
		options.warnings.push(
			`${options.key} must be an integer from ${options.min} to ${options.max}; using ${options.fallback}.`,
		);
		return options.fallback;
	}
	return value;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ConfigResult {
	const warnings: string[] = [];
	const requestedRouting = env.PI_LAZY_SKILL_ROUTING?.trim().toLowerCase();
	let routing: SkillRoutingMode = "adaptive";
	if (requestedRouting === "full") routing = "full";
	if (
		requestedRouting !== undefined &&
		requestedRouting !== "adaptive" &&
		requestedRouting !== "full"
	) {
		warnings.push(
			"PI_LAZY_SKILL_ROUTING must be adaptive or full; using adaptive.",
		);
	}
	return {
		config: {
			descriptionMax: parseBoundedInteger({
				env,
				key: "PI_LAZY_SKILL_DESCRIPTION_MAX",
				min: 0,
				max: MAX_DESCRIPTION_MAX,
				fallback: DEFAULT_DESCRIPTION_MAX,
				warnings,
			}),
			fileLimit: parseBoundedInteger({
				env,
				key: "PI_LAZY_SKILL_FILE_LIMIT",
				min: 0,
				max: MAX_FILE_LIMIT,
				fallback: DEFAULT_FILE_LIMIT,
				warnings,
			}),
			routing,
			disabled: /^(1|true|yes)$/i.test(env.PI_LAZY_SKILL_DISABLE ?? ""),
		},
		warnings,
	};
}

function isNonEmptyString(value: string): boolean {
	try {
		return value.trim().length > 0;
	} catch {
		return false;
	}
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
	if (max === 0) return normalized;
	const characters = [...normalized];
	if (characters.length <= max) return normalized;

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

function exactNameAttribute(name: string): string {
	const quoted = JSON.stringify(name);
	return escapeXml(quoted.slice(1, -1));
}

function escapeXmlText(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function renderSkillEntries(
	skills: readonly RuntimeSkill[],
	config: Pick<LazySkillConfig, "descriptionMax">,
): string[] {
	return skills
		.filter((skill) => !skill.disableModelInvocation)
		.toSorted((left, right) => left.name.localeCompare(right.name))
		.map(
			(skill) =>
				`<skill name="${exactNameAttribute(skill.name)}">${escapeXml(compactDescription(skill.description, config.descriptionMax))}</skill>`,
		);
}

export function renderCompactCatalog(
	skills: readonly RuntimeSkill[],
	config: Pick<LazySkillConfig, "descriptionMax">,
): string {
	const sorted = skills
		.filter((skill) => !skill.disableModelInvocation)
		.toSorted((a, b) => a.name.localeCompare(b.name));

	return [
		"Call `skill` by exact name (JSON escapes); resolve paths from returned base.",
		"<skills>",
		...renderSkillEntries(sorted, config),
		"</skills>",
	].join("\n");
}

export function renderAdaptiveCatalog(
	describedSkills: readonly RuntimeSkill[],
	remainingNames: readonly string[],
	config: Pick<LazySkillConfig, "descriptionMax">,
): string {
	if (remainingNames.length === 0) {
		return renderCompactCatalog(describedSkills, config);
	}
	const names = remainingNames.toSorted((left, right) =>
		left.localeCompare(right),
	);
	return [
		"Call `skill` by exact name; candidate descriptions are complete. Other exact names remain loadable.",
		"<skills>",
		...renderSkillEntries(describedSkills, config),
		"</skills>",
		`<other_skill_names>${escapeXmlText(JSON.stringify(names))}</other_skill_names>`,
	].join("\n");
}
