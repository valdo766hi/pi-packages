import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { open } from "node:fs/promises";
import type { RuntimeSkill } from "./catalog.ts";
import { sampleRelatedFiles, type RelatedFilesResult } from "./files.ts";

export const MAX_SKILL_BYTES = 50 * 1024;

export interface LoadedSkill {
	readonly body: string;
	readonly relatedFiles: RelatedFilesResult;
}

class SkillTooLargeError extends Error {
	constructor(name: string) {
		super(`Skill "${name}" exceeds the ${MAX_SKILL_BYTES}-byte limit.`);
		this.name = "SkillTooLargeError";
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
	const handle = await open(filePath, "r");
	try {
		const buffer = Buffer.allocUnsafe(MAX_SKILL_BYTES + 1);
		let bytesRead = 0;
		while (bytesRead < buffer.length) {
			throwIfAborted(signal);
			const result = await handle.read(
				buffer,
				bytesRead,
				buffer.length - bytesRead,
				null,
			);
			if (result.bytesRead === 0) break;
			bytesRead += result.bytesRead;
		}
		throwIfAborted(signal);
		if (bytesRead > MAX_SKILL_BYTES) throw new SkillTooLargeError(name);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		try {
			await handle.close();
		} catch {
			// The file may disappear during a refresh.
		}
	}
}

export async function loadSkill(
	skill: RuntimeSkill,
	fileLimit: number,
	signal?: AbortSignal,
): Promise<LoadedSkill> {
	throwIfAborted(signal);

	let rawContent: string;
	try {
		rawContent = await readSkillFile(skill.filePath, skill.name, signal);
	} catch (error) {
		throwIfAborted(signal);
		if (isAbortError(error) || error instanceof SkillTooLargeError) {
			throw error;
		}
		throw new Error(`Skill "${skill.name}" is no longer readable.`);
	}

	throwIfAborted(signal);

	let body: string;
	try {
		body = parseFrontmatter<Record<string, unknown>>(rawContent).body.trim();
	} catch {
		throw new Error(`Skill "${skill.name}" has invalid frontmatter.`);
	}

	const relatedFiles = await sampleRelatedFiles(
		skill.baseDir,
		skill.filePath,
		fileLimit,
		signal,
	);
	return { body, relatedFiles };
}
