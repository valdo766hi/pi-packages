import type { LazySkillConfig, RuntimeSkill } from "./catalog.ts";
import { escapeXml, renderCompactCatalog } from "./catalog.ts";

const OPEN_TAG = "<available_skills>";
const CLOSE_TAG = "</available_skills>";
const MAX_INSTRUCTION_PARAGRAPH_LENGTH = 800;

export interface PromptTransformResult {
	readonly prompt: string;
	readonly replaced: boolean;
	readonly warning?: string;
}

function trimTrailingWhitespaceEnd(value: string): number {
	let end = value.length;
	while (end > 0 && /\s/u.test(value[end - 1] ?? "")) end -= 1;
	return end;
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
	const blocks: SkillBlock[] = [];
	let cursor = 0;
	while (cursor < prompt.length) {
		const openingIndex = prompt.indexOf(OPEN_TAG, cursor);
		if (openingIndex === -1) break;
		const closingIndex = prompt.indexOf(
			CLOSE_TAG,
			openingIndex + OPEN_TAG.length,
		);
		if (closingIndex !== -1) {
			blocks.push({ openingIndex, closingIndex });
			cursor = closingIndex + CLOSE_TAG.length;
		} else {
			cursor = openingIndex + OPEN_TAG.length;
		}
	}
	return blocks;
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
	const actualNames = [...content.matchAll(/<name>([^<]*)<\/name>/gu)].map(
		(match) => match[1] ?? "",
	);
	const expectedNames = skills.map((skill) => escapeXml(skill.name)).toSorted();
	return (
		actualNames.length === expectedNames.length &&
		actualNames.toSorted().every((name, index) => name === expectedNames[index])
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

export function transformSkillPrompt(
	systemPrompt: string,
	skills: readonly RuntimeSkill[],
	config: Pick<LazySkillConfig, "descriptionMax">,
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
	const compactCatalog = renderCompactCatalog(skills, config);

	return {
		prompt: `${prefix}${compactCatalog}${suffix}`,
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
): PromptTransformResult {
	if (skills.length === 0) {
		return { prompt: systemPrompt, replaced: false };
	}

	const transformed = transformSkillPrompt(systemPrompt, skills, config);
	if (transformed.replaced) return transformed;

	const compactCatalog = renderCompactCatalog(skills, config);
	if (systemPrompt.includes(compactCatalog)) {
		return { prompt: systemPrompt, replaced: false };
	}

	return {
		prompt: `${systemPrompt.trimEnd()}\n\n${compactCatalog}`,
		replaced: true,
	};
}
