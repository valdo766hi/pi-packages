import { opendir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, resolve } from "node:path";

const MAX_DIRECTORIES_VISITED = 64;
const MAX_ENTRIES_PER_DIRECTORY = 1024;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

export interface RelatedFilesResult {
	readonly files: readonly string[];
	readonly truncated: boolean;
	readonly directoriesVisited: number;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	signal.throwIfAborted();
	throw new DOMException("The operation was aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function compareText(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
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
			if (entries.length >= MAX_ENTRIES_PER_DIRECTORY) {
				truncated = true;
				break;
			}
			const entry = await handle.read();
			if (entry === null) break;
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

	entries.sort((left, right) => compareText(left.name, right.name));
	return { entries, truncated };
}

function hasRelatedEntry(
	entries: readonly Dirent<string>[],
	start: number,
	directory: string,
	primary: string,
): boolean {
	for (let index = start; index < entries.length; index += 1) {
		const entry = entries[index];
		if (!entry || entry.isSymbolicLink() || entry.name.startsWith(".")) {
			continue;
		}
		if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) return true;
		if (
			entry.isFile() &&
			entry.name !== "SKILL.md" &&
			resolve(join(directory, entry.name)) !== primary
		) {
			return true;
		}
	}
	return false;
}

export async function sampleRelatedFiles(
	baseDir: string,
	primaryFile: string,
	limit: number,
	signal?: AbortSignal,
): Promise<RelatedFilesResult> {
	if (limit === 0) {
		return { files: [], truncated: false, directoriesVisited: 0 };
	}

	const primary = resolve(primaryFile);
	const queue = [resolve(baseDir)];
	const files: string[] = [];
	let visitedDirectories = 0;
	let truncated = false;

	search: while (queue.length > 0) {
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
		for (const [index, entry] of directoryEntries.entries.entries()) {
			throwIfAborted(signal);
			if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue;

			const entryPath = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
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

			files.push(entryPath);
			if (files.length < limit) continue;

			const hasUnvisitedEntries = hasRelatedEntry(
				directoryEntries.entries,
				index + 1,
				directory,
				primary,
			);
			if (hasUnvisitedEntries || queue.length > 0) truncated = true;
			break search;
		}
	}

	if (queue.length > 0) truncated = true;
	files.sort(compareText);
	return { files, truncated, directoriesVisited: visitedDirectories };
}
