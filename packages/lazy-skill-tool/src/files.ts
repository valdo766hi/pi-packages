import { opendir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, resolve } from "node:path";

const MAX_DIRECTORIES_VISITED = 512;
const MAX_ENTRIES_PER_DIRECTORY = 1024;

export interface RelatedFilesResult {
	readonly files: readonly string[];
	readonly truncated: boolean;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	signal.throwIfAborted();
	throw new DOMException("The operation was aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

async function readDirectoryEntries(
	directory: string,
	signal: AbortSignal | undefined,
): Promise<{ entries: Dirent<string>[]; truncated: boolean }> {
	let handle: Awaited<ReturnType<typeof opendir>> | undefined;
	const entries: Dirent<string>[] = [];
	let truncated = false;

	try {
		handle = await opendir(directory, { encoding: "utf8" });
		while (true) {
			throwIfAborted(signal);
			const entry = await handle.read();
			if (entry === null) break;
			if (entries.length >= MAX_ENTRIES_PER_DIRECTORY) {
				truncated = true;
				break;
			}
			entries.push(entry);
		}
	} catch (error) {
		throwIfAborted(signal);
		if (isAbortError(error)) throw error;
		return { entries: [], truncated: true };
	} finally {
		if (handle) {
			try {
				await handle.close();
			} catch {
				// The directory may disappear during a refresh.
			}
		}
	}

	entries.sort((a, b) => a.name.localeCompare(b.name));
	return { entries, truncated };
}

export async function sampleRelatedFiles(
	baseDir: string,
	primaryFile: string,
	limit: number,
	signal?: AbortSignal,
): Promise<RelatedFilesResult> {
	if (limit === 0) return { files: [], truncated: false };

	const primary = resolve(primaryFile);
	const queue = [resolve(baseDir)];
	const files: string[] = [];
	let visitedDirectories = 0;
	let truncated = false;

	while (queue.length > 0) {
		throwIfAborted(signal);
		if (visitedDirectories >= MAX_DIRECTORIES_VISITED) {
			truncated = true;
			break;
		}

		const directory = queue.shift();
		if (directory === undefined) break;
		visitedDirectories += 1;

		const directoryEntries = await readDirectoryEntries(directory, signal);
		truncated ||= directoryEntries.truncated;
		for (const entry of directoryEntries.entries) {
			throwIfAborted(signal);
			if (entry.isSymbolicLink()) continue;

			const entryPath = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (visitedDirectories + queue.length < MAX_DIRECTORIES_VISITED) {
					queue.push(entryPath);
				} else {
					truncated = true;
				}
				continue;
			}

			if (
				!entry.isFile() ||
				entry.name === "SKILL.md" ||
				resolve(entryPath) === primary
			) {
				continue;
			}

			if (files.length >= limit) {
				truncated = true;
				break;
			}
			files.push(entryPath);
		}
	}

	if (queue.length > 0) truncated = true;
	files.sort((a, b) => a.localeCompare(b));
	return { files, truncated };
}
