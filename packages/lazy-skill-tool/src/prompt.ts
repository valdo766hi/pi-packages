import type { LazySkillConfig, RuntimeSkill } from "./catalog.ts";
import {
	escapeXml,
	renderAdaptiveCatalog,
	renderCompactCatalog,
} from "./catalog.ts";
import type { RoutingSelection } from "./routing.ts";

const OPEN_TAG = "<available_skills>";
const CLOSE_TAG = "</available_skills>";
const MAX_INSTRUCTION_PARAGRAPH_LENGTH = 800;

export interface PromptTransformResult {
	readonly prompt: string;
	readonly replaced: boolean;
	readonly warning?: string;
}

function trimTrailingWhitespaceEnd(value: string): number {
	return value.trimEnd().length;
}

function isSkillInstruction(value: string): boolean {
	if (value.length === 0 || value.length > MAX_INSTRUCTION_PARAGRAPH_LENGTH)
		return false;
	if (value.includes("<") || value.includes(">")) return false;

	const mentionsSkills = /\bskills?\b/iu.test(value);
	const mentionsLoader =
		/\b(read|load)\b/iu.test(value) ||
		/\bskill\b[^\n]{0,40}\btool\b/iu.test(value);
	return mentionsSkills && mentionsLoader;
}

interface SkillBlock {
	readonly openingIndex: number;
	readonly closingIndex: number;
}

function findSkillBlocks(prompt: string): SkillBlock[] {
	const pattern = /<available_skills>[\s\S]*?<\/available_skills>/gu;
	return [...prompt.matchAll(pattern)].map((match) => {
		const openingIndex = match.index;
		const closingIndex = openingIndex + match[0].lastIndexOf(CLOSE_TAG);
		return { openingIndex, closingIndex };
	});
}

function blockMatchesSnapshot(
	prompt: string,
	block: SkillBlock,
	skills: readonly RuntimeSkill[],
): boolean {
	const content = prompt.slice(
		block.openingIndex,
		block.closingIndex + CLOSE_TAG.length,
	);
	const attributeNames = [
		...content.matchAll(/<skill\b[^>]*\bname="([^"]*)"[^>]*>/gu),
	].map((match) => match[1] ?? "");
	const nestedNames = [...content.matchAll(/<name>([^<]*)<\/name>/gu)].map(
		(match) => match[1] ?? "",
	);
	const actualNames = [...attributeNames, ...nestedNames];
	const expectedNames = skills
		.map((skill) => escapeXml(skill.name))
		.toSorted((left, right) => left.localeCompare(right));
	return (
		actualNames.length === expectedNames.length &&
		actualNames
			.toSorted((left, right) => left.localeCompare(right))
			.every((name, index) => name === expectedNames[index])
	);
}

function selectSkillBlock(
	prompt: string,
	skills: readonly RuntimeSkill[],
): { block?: SkillBlock; warning?: string } {
	if (skills.length === 0) return {};

	const blocks = findSkillBlocks(prompt);
	if (blocks.length === 0) {
		if (prompt.includes(OPEN_TAG)) {
			return {
				warning:
					"Pi's <available_skills> block is incomplete; the native prompt was left unchanged.",
			};
		}
		return {
			warning:
				"Pi's <available_skills> block was not found; the native prompt was left unchanged.",
		};
	}

	const matchingBlocks = blocks.filter(
		(block) =>
			findInstructionStart(prompt, block.openingIndex) !== undefined &&
			blockMatchesSnapshot(prompt, block, skills),
	);
	const block = matchingBlocks.at(-1);
	if (block) return { block };
	if (blocks.length === 1) {
		return {
			warning:
				"A skill XML block was found without Pi's skill-loading instruction and current skill entries; the native prompt was left unchanged.",
		};
	}
	return {
		warning:
			"Multiple <available_skills> blocks were found without a canonical match; the native prompt was left unchanged.",
	};
}

function findInstructionStart(
	prompt: string,
	openingIndex: number,
): number | undefined {
	const contentEnd = trimTrailingWhitespaceEnd(prompt.slice(0, openingIndex));
	const separator = prompt.lastIndexOf("\n\n", contentEnd - 1);
	const candidateStart = separator === -1 ? 0 : separator + 2;
	const candidate = prompt.slice(candidateStart, contentEnd).trim();

	return isSkillInstruction(candidate) ? candidateStart : undefined;
}

function renderCatalog(
	snapshotSkills: readonly RuntimeSkill[],
	config: Pick<LazySkillConfig, "descriptionMax">,
	selection?: RoutingSelection,
): string {
	if (!selection || selection.fallback) {
		return renderCompactCatalog(snapshotSkills, config);
	}
	return renderAdaptiveCatalog(
		selection.describedSkills,
		selection.remainingNames,
		config,
	);
}

export function transformSkillPrompt(
	systemPrompt: string,
	skills: readonly RuntimeSkill[],
	config: Pick<LazySkillConfig, "descriptionMax">,
	selection?: RoutingSelection,
): PromptTransformResult {
	const selected = selectSkillBlock(systemPrompt, skills);
	if (!selected.block) {
		return {
			prompt: systemPrompt,
			replaced: false,
			warning: selected.warning,
		};
	}

	const { openingIndex, closingIndex } = selected.block;
	const instructionStart = findInstructionStart(systemPrompt, openingIndex);
	const replacementStart = instructionStart ?? openingIndex;
	const replacementEnd = closingIndex + CLOSE_TAG.length;
	const prefix = systemPrompt.slice(0, replacementStart);
	const suffix = systemPrompt.slice(replacementEnd);
	const catalog = renderCatalog(skills, config, selection);

	return {
		prompt: `${prefix}${catalog}${suffix}`,
		replaced: true,
		warning:
			instructionStart === undefined
				? "Pi's skill-loading instruction was not recognized; the native surrounding text was preserved."
				: undefined,
	};
}

export function appendSkillCatalog(
	systemPrompt: string,
	skills: readonly RuntimeSkill[],
	config: Pick<LazySkillConfig, "descriptionMax">,
	selection?: RoutingSelection,
): PromptTransformResult {
	if (skills.length === 0) {
		return { prompt: systemPrompt, replaced: false };
	}

	const transformed = transformSkillPrompt(
		systemPrompt,
		skills,
		config,
		selection,
	);
	if (transformed.replaced) return transformed;

	const compactCatalog = renderCatalog(skills, config, selection);
	if (systemPrompt.includes(compactCatalog)) {
		return { prompt: systemPrompt, replaced: false };
	}

	return {
		prompt: `${systemPrompt.trimEnd()}\n\n${compactCatalog}`,
		replaced: true,
	};
}
