import {
	formatSkillsForPrompt,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import {
	renderAdaptiveCatalog,
	renderSafeCatalog,
	ROUTING_MESSAGE_TYPE,
	type RuntimeSkill,
} from "./catalog.ts";
import type { LazySkillConfig } from "./config.ts";
import { lazySkillErrorMessage, type LazySkillErrorCode } from "./errors.ts";
import type { AdaptiveDisclosure, RoutingSelection } from "./routing.ts";

export type NativeSkillReadTool = "read" | "bash";

export interface PromptTransformResult {
	readonly prompt: string;
	readonly replaced: boolean;
	readonly sanitized?: boolean;
	readonly failure?: "missing" | "multiple";
	readonly warning?: string;
}

interface DescriptionConfig {
	readonly maxDescriptionCharacters?: number;
	readonly descriptionMax?: number;
}

function renderCatalog(
	skills: readonly RuntimeSkill[],
	config: DescriptionConfig,
	selection?: RoutingSelection,
): string {
	if (!selection || selection.fallback) return renderSafeCatalog(skills, config);
	return renderAdaptiveCatalog(
		selection.describedSkills,
		selection.remainingNames,
		config,
		selection.remainingNames.length > 0,
	);
}

export function renderDisclosureCatalog(
	disclosure: AdaptiveDisclosure,
	config: DescriptionConfig,
): string {
	if (disclosure.strategy === "full-catalog") {
		return renderSafeCatalog(disclosure.describedSkills, config);
	}
	return renderAdaptiveCatalog(
		disclosure.describedSkills,
		disclosure.remainingNames,
		config,
		disclosure.incomplete,
	);
}

export function routingHintMessage(
	catalog: string,
	details: Record<string, unknown>,
): {
	customType: string;
	content: string;
	display: false;
	details: Record<string, unknown>;
} {
	return {
		customType: ROUTING_MESSAGE_TYPE,
		content: catalog,
		display: false,
		details,
	};
}

export function isRoutingHintMessage(message: {
	readonly role?: string;
	readonly customType?: string;
}): boolean {
	return message.role === "custom" && message.customType === ROUTING_MESSAGE_TYPE;
}

export function pruneRoutingHintMessages<T extends { readonly role?: string; readonly customType?: string }>(
	messages: readonly T[],
): T[] {
	let latest = -1;
	for (let index = 0; index < messages.length; index += 1) {
		if (isRoutingHintMessage(messages[index] ?? {})) latest = index;
	}
	if (latest === -1) return [...messages];
	return messages.filter((message, index) => {
		if (!isRoutingHintMessage(message)) return true;
		return index === latest;
	});
}

function occurrenceIndexes(value: string, needle: string): number[] {
	if (!needle) return [];
	const indexes: number[] = [];
	let index = value.indexOf(needle);
	while (index !== -1) {
		indexes.push(index);
		index = value.indexOf(needle, index + needle.length);
	}
	return indexes;
}

interface NativeSectionMatch {
	readonly index: number;
	readonly section: string;
}

function nativeSections(
	canonicalSkills: readonly Skill[],
	tools: readonly NativeSkillReadTool[],
): string[] {
	return [
		...new Set(
			tools
				.map((tool) => formatSkillsForPrompt([...canonicalSkills], tool))
				.filter((section) => section.length > 0),
		),
	];
}

function replaceNativeSections(
	systemPrompt: string,
	sections: readonly string[],
	catalog: string,
	missingIsFailure: boolean,
): PromptTransformResult {
	const matches: NativeSectionMatch[] = sections.flatMap((section) =>
		occurrenceIndexes(systemPrompt, section).map((index) => ({ index, section })),
	);
	if (matches.length === 0) {
		if (!missingIsFailure) {
			return appendCanonicalSkillCatalog(systemPrompt, catalog);
		}
		return {
			prompt: systemPrompt,
			replaced: false,
			failure: "missing",
			warning:
				"Pi's exact canonical skill section was not found; prompt integration failed.",
		};
	}
	if (matches.length > 1) {
		let sanitizedPrompt = systemPrompt;
		for (const section of sections) {
			sanitizedPrompt = sanitizedPrompt.split(section).join("");
		}
		return {
			prompt: sanitizedPrompt,
			replaced: false,
			sanitized: true,
			failure: "multiple",
			warning:
				"Multiple exact canonical skill sections were found and removed; prompt integration failed.",
		};
	}
	const match = matches[0];
	if (!match) return { prompt: systemPrompt, replaced: false };
	const replacement = catalog ? `\n\n${catalog}` : "";
	return {
		prompt:
			systemPrompt.slice(0, match.index) +
			replacement +
			systemPrompt.slice(match.index + match.section.length),
		replaced: true,
	};
}

export function replaceCanonicalSkillPrompt(
	systemPrompt: string,
	canonicalSkills: readonly Skill[],
	catalog: string,
	fileReadTool: NativeSkillReadTool,
): PromptTransformResult {
	const sections = nativeSections(canonicalSkills, [fileReadTool]);
	if (sections.length === 0) {
		return { prompt: systemPrompt, replaced: false };
	}
	return replaceNativeSections(systemPrompt, sections, catalog, true);
}

export function failClosedHostPrompt(
	systemPrompt: string,
	canonicalSkills: readonly Skill[],
	code: LazySkillErrorCode,
	fileReadTool?: NativeSkillReadTool,
): PromptTransformResult {
	const notice = lazySkillErrorMessage(code);
	let stripped: PromptTransformResult = {
		prompt: systemPrompt,
		replaced: false,
	};
	try {
		const sections = nativeSections(
			canonicalSkills,
			fileReadTool ? [fileReadTool] : ["read", "bash"],
		);
		if (sections.length > 0) {
			stripped = replaceNativeSections(systemPrompt, sections, "", true);
		}
	} catch {
		stripped = { prompt: systemPrompt, replaced: false };
	}
	const prompt = stripped.prompt.includes(notice)
		? stripped.prompt
		: `${stripped.prompt.trimEnd()}\n\n${notice}`;
	return {
		...stripped,
		prompt,
		replaced: true,
	};
}

export function appendCanonicalSkillCatalog(
	systemPrompt: string,
	catalog: string,
): PromptTransformResult {
	if (!catalog || systemPrompt.includes(catalog)) {
		return { prompt: systemPrompt, replaced: false };
	}
	return {
		prompt: `${systemPrompt.trimEnd()}\n\n${catalog}`,
		replaced: true,
	};
}

export function replaceOrAppendCanonicalSkillCatalog(
	systemPrompt: string,
	canonicalSkills: readonly Skill[],
	catalog: string,
): PromptTransformResult {
	const sections = nativeSections(canonicalSkills, ["read", "bash"]);
	return replaceNativeSections(systemPrompt, sections, catalog, false);
}

export function transformSkillPrompt(
	systemPrompt: string,
	skills: readonly RuntimeSkill[],
	config: DescriptionConfig,
	selection?: RoutingSelection,
	fileReadTool: NativeSkillReadTool = "read",
): PromptTransformResult {
	return replaceCanonicalSkillPrompt(
		systemPrompt,
		skills as readonly Skill[],
		renderCatalog(skills, config, selection),
		fileReadTool,
	);
}

export function appendSkillCatalog(
	systemPrompt: string,
	skills: readonly RuntimeSkill[],
	config: DescriptionConfig,
	selection?: RoutingSelection,
): PromptTransformResult {
	return appendCanonicalSkillCatalog(
		systemPrompt,
		renderCatalog(skills, config, selection),
	);
}

export type PromptCatalogConfig = Pick<
	LazySkillConfig,
	"maxDescriptionCharacters"
>;
