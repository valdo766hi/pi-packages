import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	parseFrontmatter,
	truncateHead,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { RuntimeSkill } from "./catalog.ts";
import { DEFAULT_MAX_SOURCE_BYTES } from "./config.ts";
import { LazySkillError } from "./errors.ts";
import { sampleRelatedFiles, type RelatedFilesResult } from "./files.ts";

/** Maximum bytes returned in one model-facing chunk. */
export const MAX_SKILL_BYTES = DEFAULT_MAX_BYTES;
export const MAX_SKILL_LINES = DEFAULT_MAX_LINES;
const INITIAL_SOURCE_READ_BYTES = 64 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export interface ValidatedSkillBody {
	readonly body: string;
	readonly disableModelInvocation: boolean;
}

export interface LoadedSkill {
	readonly body: string;
	readonly sourceRevision: string;
	readonly bodyOffset: number;
	readonly bodyColumn: number;
	readonly bodyTruncation: TruncationResult;
	readonly nextOffset?: number;
	readonly nextColumn?: number;
	readonly relatedFiles: RelatedFilesResult;
}

export function skillSourceRevision(body: string): string {
	return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	signal.throwIfAborted();
	throw new DOMException("The operation was aborted", "AbortError");
}

function invalidFrontmatter(
	skill: RuntimeSkill,
	cause?: unknown,
): LazySkillError {
	return new LazySkillError("SKILL_INVALID_FRONTMATTER", {
		requestedName: skill.name,
		canonicalPath: skill.filePath,
		cause,
	});
}

function hasFrontmatterEnvelope(content: string): boolean {
	const normalized = content.includes("\r")
		? content.replace(/\r\n?/gu, "\n")
		: content;
	if (!normalized.startsWith("---\n")) return false;
	const closingIndex = normalized.indexOf("\n---", 4);
	if (closingIndex === -1) return false;
	const afterClosing = closingIndex + 4;
	return afterClosing === normalized.length || normalized[afterClosing] === "\n";
}

async function readBoundedSkillSource(
	skill: RuntimeSkill,
	maxSourceBytes: number,
	signal: AbortSignal | undefined,
): Promise<Buffer> {
	throwIfAborted(signal);
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(skill.filePath, "r");
		const initialCapacity = Math.min(
			INITIAL_SOURCE_READ_BYTES,
			maxSourceBytes + 1,
		);
		const initialBuffer = Buffer.allocUnsafe(Math.max(0, initialCapacity));
		const [metadata, initialRead] = await Promise.all([
			handle.stat(),
			handle.read(initialBuffer, 0, initialBuffer.byteLength, 0),
		]);
		throwIfAborted(signal);
		if (!metadata.isFile()) {
			throw new LazySkillError("SKILL_UNREADABLE", {
				requestedName: skill.name,
				canonicalPath: skill.filePath,
			});
		}
		if (
			metadata.size > maxSourceBytes ||
			initialRead.bytesRead > maxSourceBytes
		) {
			throw new LazySkillError("SKILL_SOURCE_TOO_LARGE", {
				requestedName: skill.name,
				canonicalPath: skill.filePath,
			});
		}

		const expectedBytes = Math.max(metadata.size, initialRead.bytesRead);
		if (expectedBytes === initialRead.bytesRead) {
			return initialBuffer.subarray(0, initialRead.bytesRead);
		}
		const buffer = Buffer.allocUnsafe(expectedBytes);
		initialBuffer.copy(buffer, 0, 0, initialRead.bytesRead);
		let bytesRead = initialRead.bytesRead;
		while (bytesRead < buffer.byteLength) {
			throwIfAborted(signal);
			const result = await handle.read(
				buffer,
				bytesRead,
				buffer.byteLength - bytesRead,
				bytesRead,
			);
			if (result.bytesRead === 0) break;
			bytesRead += result.bytesRead;
		}
		throwIfAborted(signal);
		const source = buffer.subarray(0, bytesRead);
		if (source.byteLength > maxSourceBytes) {
			throw new LazySkillError("SKILL_SOURCE_TOO_LARGE", {
				requestedName: skill.name,
				canonicalPath: skill.filePath,
			});
		}
		return source;
	} catch (error) {
		throwIfAborted(signal);
		if (isAbortError(error) || error instanceof LazySkillError) throw error;
		throw new LazySkillError("SKILL_UNREADABLE", {
			requestedName: skill.name,
			canonicalPath: skill.filePath,
			cause: error,
		});
	} finally {
		try {
			await handle?.close();
		} catch {
			// The validated read result or primary error remains authoritative.
		}
	}
}

/**
 * Read and revalidate the canonical skill source without caching its body.
 * The returned body uses Pi's frontmatter stripping semantics.
 */
export async function readValidatedSkillBody(
	skill: RuntimeSkill,
	maxSourceBytes = DEFAULT_MAX_SOURCE_BYTES,
	signal?: AbortSignal,
	allowModelDisabled = false,
): Promise<ValidatedSkillBody> {
	const buffer = await readBoundedSkillSource(skill, maxSourceBytes, signal);
	let source: string;
	try {
		source = UTF8_DECODER.decode(buffer);
	} catch (cause) {
		throw new LazySkillError("SKILL_INVALID_UTF8", {
			requestedName: skill.name,
			canonicalPath: skill.filePath,
			cause,
		});
	}
	throwIfAborted(signal);
	if (!hasFrontmatterEnvelope(source)) throw invalidFrontmatter(skill);

	let parsed: ReturnType<typeof parseFrontmatter<Record<string, unknown>>>;
	try {
		parsed = parseFrontmatter<Record<string, unknown>>(source);
	} catch (cause) {
		throw invalidFrontmatter(skill, cause);
	}
	const description = parsed.frontmatter.description;
	if (typeof description !== "string" || description.trim().length === 0) {
		throw invalidFrontmatter(skill);
	}
	const declaredName = parsed.frontmatter.name;
	if (
		declaredName !== undefined &&
		declaredName !== null &&
		typeof declaredName !== "string"
	) {
		throw invalidFrontmatter(skill);
	}
	const currentName =
		declaredName === undefined || declaredName === null || declaredName === ""
			? basename(dirname(skill.filePath))
			: declaredName;
	if (currentName !== skill.name) {
		throw new LazySkillError("SKILL_NAME_CHANGED", {
			requestedName: skill.name,
			canonicalPath: skill.filePath,
		});
	}
	const disabled = parsed.frontmatter["disable-model-invocation"];
	if (disabled !== undefined && typeof disabled !== "boolean") {
		throw invalidFrontmatter(skill);
	}
	if (disabled === true && !allowModelDisabled) {
		throw new LazySkillError("SKILL_DISABLED_FOR_MODEL", {
			requestedName: skill.name,
			canonicalPath: skill.filePath,
		});
	}
	if (parsed.body.length === 0) {
		throw new LazySkillError("SKILL_EMPTY", {
			requestedName: skill.name,
			canonicalPath: skill.filePath,
		});
	}
	throwIfAborted(signal);
	return {
		body: parsed.body,
		disableModelInvocation: disabled === true,
	};
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
	maxSourceBytes = DEFAULT_MAX_SOURCE_BYTES,
	expectedRevision?: string,
): Promise<LoadedSkill> {
	const validated = await readValidatedSkillBody(
		skill,
		maxSourceBytes,
		signal,
		false,
	);
	const sourceRevision = skillSourceRevision(validated.body);
	const continuation = offset !== 1 || column !== 1;
	if (continuation && expectedRevision === undefined) {
		throw new LazySkillError("SKILL_SOURCE_CHANGED", {
			requestedName: skill.name,
			canonicalPath: skill.filePath,
		});
	}
	if (expectedRevision !== undefined && expectedRevision !== sourceRevision) {
		throw new LazySkillError("SKILL_SOURCE_CHANGED", {
			requestedName: skill.name,
			canonicalPath: skill.filePath,
		});
	}
	const lines = validated.body.split("\n");
	if (!Number.isInteger(offset) || offset < 1 || offset > lines.length) {
		throw new LazySkillError("SKILL_OFFSET_INVALID", {
			requestedName: skill.name,
			canonicalPath: skill.filePath,
		});
	}
	const line = lines[offset - 1] ?? "";
	const firstLine =
		Number.isInteger(column) && column >= 1
			? sliceFromCharacter(line, column)
			: undefined;
	if (firstLine === undefined) {
		throw new LazySkillError("SKILL_OFFSET_INVALID", {
			requestedName: skill.name,
			canonicalPath: skill.filePath,
		});
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

	throwIfAborted(signal);
	const relatedFiles = await sampleRelatedFiles(
		skill.baseDir,
		skill.filePath,
		offset === 1 && column === 1 ? fileLimit : 0,
		signal,
	);
	throwIfAborted(signal);
	return {
		body,
		sourceRevision,
		bodyOffset: offset,
		bodyColumn: column,
		bodyTruncation,
		...(nextOffset === undefined ? {} : { nextOffset, nextColumn }),
		relatedFiles,
	};
}
