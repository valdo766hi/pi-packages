import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	parseFrontmatter,
	truncateHead,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { RuntimeSkill } from "./catalog.ts";
import { sampleRelatedFiles, type RelatedFilesResult } from "./files.ts";

export const MAX_SKILL_BYTES = DEFAULT_MAX_BYTES;
export const MAX_SKILL_LINES = DEFAULT_MAX_LINES;

export interface LoadedSkill {
	readonly body: string;
	readonly bodyOffset: number;
	readonly bodyColumn: number;
	readonly bodyTruncation: TruncationResult;
	readonly nextOffset?: number;
	readonly nextColumn?: number;
	readonly relatedFiles: RelatedFilesResult;
}

class SkillInvalidEncodingError extends Error {
	constructor(name: string) {
		super(`Skill "${name}" is not valid UTF-8.`);
		this.name = "SkillInvalidEncodingError";
	}
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	signal.throwIfAborted();
	throw new DOMException("The operation was aborted", "AbortError");
}

async function readSkillFile(
	filePath: string,
	name: string,
	signal: AbortSignal | undefined,
): Promise<string> {
	const buffer = await readFile(filePath, { signal });
	throwIfAborted(signal);
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	} catch {
		throw new SkillInvalidEncodingError(name);
	}
}

function validateSkillFile(rawContent: string, skill: RuntimeSkill): void {
	const normalized = rawContent.replace(/\r\n?/gu, "\n");
	const closingIndex = normalized.indexOf("\n---", 4);
	const afterClosing = closingIndex + 4;
	if (
		!normalized.startsWith("---\n") ||
		closingIndex === -1 ||
		(afterClosing < normalized.length && normalized[afterClosing] !== "\n")
	) {
		throw new Error(`Skill "${skill.name}" has invalid frontmatter.`);
	}

	let parsed: ReturnType<typeof parseFrontmatter<Record<string, unknown>>>;
	try {
		parsed = parseFrontmatter<Record<string, unknown>>(rawContent);
	} catch {
		throw new Error(`Skill "${skill.name}" has invalid frontmatter.`);
	}

	const description = parsed.frontmatter.description;
	const currentName = parsed.frontmatter.name;
	const canonicalName =
		currentName === undefined || currentName === null || currentName === ""
			? basename(dirname(skill.filePath))
			: currentName;
	if (
		typeof description !== "string" ||
		description.trim().length === 0 ||
		typeof canonicalName !== "string" ||
		canonicalName !== skill.name
	) {
		throw new Error(`Skill "${skill.name}" has invalid frontmatter.`);
	}
	if (parsed.frontmatter["disable-model-invocation"] === true) {
		throw new Error(`Skill "${skill.name}" is no longer available.`);
	}
	if (parsed.body.trim().length === 0) {
		throw new Error(`Skill "${skill.name}" has no instructions.`);
	}
}

function sliceFromCharacter(value: string, column: number): string | undefined {
	let characterColumn = 1;
	let codeUnitIndex = 0;
	for (const character of value) {
		if (characterColumn === column) return value.slice(codeUnitIndex);
		codeUnitIndex += character.length;
		characterColumn += 1;
	}
	return characterColumn === column ? "" : undefined;
}

function takeByteBoundedPrefix(value: string, maxBytes: number) {
	let bytes = 0;
	const content: string[] = [];
	for (const character of value) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (bytes + characterBytes > maxBytes) break;
		content.push(character);
		bytes += characterBytes;
	}
	return { content: content.join(""), characters: content.length };
}

export async function loadSkill(
	skill: RuntimeSkill,
	fileLimit: number,
	signal?: AbortSignal,
	offset = 1,
	column = 1,
): Promise<LoadedSkill> {
	throwIfAborted(signal);

	let rawContent: string;
	try {
		rawContent = await readSkillFile(skill.filePath, skill.name, signal);
	} catch (error) {
		throwIfAborted(signal);
		if (isAbortError(error) || error instanceof SkillInvalidEncodingError) {
			throw error;
		}
		throw new Error(`Skill "${skill.name}" is no longer readable.`);
	}

	throwIfAborted(signal);
	validateSkillFile(rawContent, skill);

	const lines = rawContent.split("\n");
	if (!Number.isInteger(offset) || offset < 1 || offset > lines.length) {
		throw new Error(
			`Skill "${skill.name}" offset ${offset} is beyond its ${lines.length} file lines.`,
		);
	}
	const line = lines[offset - 1] ?? "";
	const firstLine =
		Number.isInteger(column) && column >= 1
			? sliceFromCharacter(line, column)
			: undefined;
	if (firstLine === undefined) {
		throw new Error(
			`Skill "${skill.name}" column ${column} is beyond line ${offset}.`,
		);
	}
	const remainingContent = [firstLine, ...lines.slice(offset)].join("\n");
	let bodyTruncation = truncateHead(remainingContent);
	let body = bodyTruncation.content;
	let nextOffset: number | undefined;
	let nextColumn: number | undefined;
	if (bodyTruncation.firstLineExceedsLimit) {
		const segment = takeByteBoundedPrefix(firstLine, bodyTruncation.maxBytes);
		body = segment.content;
		bodyTruncation = {
			...bodyTruncation,
			content: segment.content,
			outputLines: segment.content.length === 0 ? 0 : 1,
			outputBytes: Buffer.byteLength(segment.content, "utf8"),
			lastLinePartial: true,
		};
		nextOffset = offset;
		nextColumn = column + segment.characters;
	} else if (bodyTruncation.truncated && bodyTruncation.outputLines > 0) {
		nextOffset = offset + bodyTruncation.outputLines;
		nextColumn = 1;
	}

	const relatedFiles = await sampleRelatedFiles(
		skill.baseDir,
		skill.filePath,
		offset === 1 && column === 1 ? fileLimit : 0,
		signal,
	);
	return {
		body,
		bodyOffset: offset,
		bodyColumn: column,
		bodyTruncation,
		...(nextOffset === undefined ? {} : { nextOffset, nextColumn }),
		relatedFiles,
	};
}
