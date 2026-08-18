// @ts-nocheck -- Pi provides its extension types at runtime.
import {
	getAgentDir,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const CONFIG_PATH = [
	"extensions",
	"pi-permission-system",
	"config.json",
] as const;
const STATE_PATH = ["yolo-state.json"] as const;

type PermissionConfig = {
	yoloMode?: unknown;
};

type PersistedYoloState = {
	enabled: boolean;
};

function permissionConfigPath(): string {
	return join(getAgentDir(), ...CONFIG_PATH);
}

function yoloStatePath(): string {
	return join(getAgentDir(), ...STATE_PATH);
}

function isMissingFile(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}

/**
 * Native yolo rewrites ask→allow on every surface, including
 * external_directory, while leaving explicit deny rules untouched.
 */
function readNativeYoloMode(): boolean {
	const config = JSON.parse(
		readFileSync(permissionConfigPath(), "utf8"),
	) as PermissionConfig;
	return config.yoloMode === true;
}

/**
 * Read the user's last explicit toggle. A missing state file is initialized
 * from the native setting for upgrades; a completely new installation starts
 * with YOLO off.
 */
function readPersistedYoloMode(): boolean {
	try {
		const state = JSON.parse(
			readFileSync(yoloStatePath(), "utf8"),
		) as PersistedYoloState;
		if (typeof state.enabled !== "boolean") {
			throw new Error("YOLO state must contain a boolean 'enabled' value");
		}
		return state.enabled;
	} catch (error) {
		if (!isMissingFile(error)) throw error;

		let enabled = false;
		try {
			enabled = readNativeYoloMode();
		} catch (nativeError) {
			if (!isMissingFile(nativeError)) throw nativeError;
		}
		writePersistedYoloMode(enabled);
		return enabled;
	}
}

function writePersistedYoloMode(enabled: boolean): void {
	const statePath = yoloStatePath();
	const tempPath = `${statePath}.tmp`;
	let tempWritten = false;

	try {
		mkdirSync(getAgentDir(), { recursive: true });
		writeFileSync(
			tempPath,
			`${JSON.stringify({ enabled } satisfies PersistedYoloState, null, 2)}\n`,
			"utf8",
		);
		tempWritten = true;
		renameSync(tempPath, statePath);
	} catch (error) {
		if (tempWritten) {
			try {
				unlinkSync(tempPath);
			} catch {
				// Ignore cleanup failures.
			}
		}
		throw error;
	}
}

function setNativeYoloMode(enabled: boolean): void {
	const configPath = permissionConfigPath();
	const tempPath = `${configPath}.tmp`;
	let tempWritten = false;

	try {
		const config = JSON.parse(
			readFileSync(configPath, "utf8"),
		) as PermissionConfig;
		if (config.yoloMode === enabled) return;

		config.yoloMode = enabled;
		writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
		tempWritten = true;
		renameSync(tempPath, configPath);
	} catch (error) {
		if (tempWritten) {
			try {
				unlinkSync(tempPath);
			} catch {
				// Ignore cleanup failures.
			}
		}
		throw error;
	}
}

export default function (pi: ExtensionAPI) {
	let enabled = false;
	const updateStatus = (ctx) => {
		ctx.ui.setStatus("yolo", `YOLO: ${enabled ? "ON" : "OFF"}`);
	};
	const syncStatus = (ctx) => {
		try {
			const nextEnabled = readPersistedYoloMode();
			setNativeYoloMode(nextEnabled);
			enabled = nextEnabled;
		} catch (error) {
			enabled = false;
			ctx.ui.notify(
				`YOLO could not persist its state: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
		updateStatus(ctx);
	};

	pi.on("session_start", (_event, ctx) => {
		syncStatus(ctx);
	});
	pi.on("input", (_event, ctx) => {
		syncStatus(ctx);
	});
	pi.on("before_agent_start", (_event, ctx) => {
		syncStatus(ctx);
	});
	pi.on("session_compact", (_event, ctx) => {
		// Compaction rebuilds the conversation branch. YOLO is deliberately
		// read from its persistent state file instead of compacted entries.
		syncStatus(ctx);
	});

	pi.registerCommand("yolo", {
		description: "Toggle automatic approval while preserving hard denials",
		handler: async (args, ctx) => {
			const requested = args.trim().toLowerCase();
			if (requested && requested !== "on" && requested !== "off") {
				ctx.ui.notify("Usage: /yolo [on|off]", "warning");
				return;
			}

			let currentEnabled: boolean;
			try {
				currentEnabled = readPersistedYoloMode();
			} catch (error) {
				ctx.ui.notify(
					`YOLO could not read its persistent state: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}

			const nextEnabled = requested ? requested === "on" : !currentEnabled;
			try {
				writePersistedYoloMode(nextEnabled);
				setNativeYoloMode(nextEnabled);
			} catch (error) {
				ctx.ui.notify(
					`YOLO could not update its state: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}

			enabled = nextEnabled;
			updateStatus(ctx);
			ctx.ui.notify(
				`YOLO mode ${enabled ? "on" : "off"}. Hard denials still apply.`,
				enabled ? "warning" : "info",
			);

			// pi-permission-system caches its config for the session. Reload so its
			// in-memory yolo reader sees the file we just updated.
			await ctx.reload();
		},
	});
}
