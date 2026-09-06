import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export type SkillToolOwnershipStatus =
	| "owned"
	| "foreign"
	| "inactive"
	| "missing";

export interface SkillToolOwnership {
	readonly status: SkillToolOwnershipStatus;
	readonly active: boolean;
	readonly ownSource: string;
	readonly resolvedSource?: string;
}

function pathValue(value: string, platform: NodeJS.Platform): string {
	if (!value.startsWith("file:")) return value;
	try {
		return fileURLToPath(value, { windows: platform === "win32" });
	} catch {
		return value;
	}
}

/** Canonical comparison form for extension source paths. */
export function canonicalComparisonPath(
	value: string,
	platform: NodeJS.Platform = process.platform,
): string {
	const path = pathValue(value, platform);
	if (path.startsWith("<") && path.endsWith(">")) return path;
	if (platform === "win32") {
		return win32
			.normalize(win32.resolve(path))
			.replace(/[\\/]+$/u, "")
			.toLowerCase();
	}
	const absolute = resolve(path);
	let canonical = absolute;
	if (platform === process.platform) {
		try {
			canonical = realpathSync.native(absolute);
		} catch {
			// Missing paths still receive deterministic lexical normalization.
		}
	}
	return canonical.replace(/\/+$/u, "") || "/";
}

export function inspectSkillToolOwnership(
	pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools">,
	ownModulePath: string,
): SkillToolOwnership {
	const ownSource = canonicalComparisonPath(ownModulePath);
	const winner = pi.getAllTools().find((tool) => tool.name === "skill");
	const active = pi.getActiveTools().includes("skill");
	if (!winner) return { status: "missing", active, ownSource };

	const resolvedSource = canonicalComparisonPath(winner.sourceInfo.path);
	if (resolvedSource !== ownSource) {
		return {
			status: "foreign",
			active,
			ownSource,
			resolvedSource,
		};
	}
	return {
		status: active ? "owned" : "inactive",
		active,
		ownSource,
		resolvedSource,
	};
}
