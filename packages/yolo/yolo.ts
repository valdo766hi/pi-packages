// @ts-nocheck -- Pi provides its extension types at runtime.
import {
	getAgentDir,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STATE_TYPE = "yolo-state";
const CONFIG_PATH = [
	"extensions",
	"pi-permission-system",
	"config.json",
] as const;

type PermissionConfig = {
	yoloMode?: unknown;
};

function permissionConfigPath(): string {
	return join(getAgentDir(), ...CONFIG_PATH);
}

/**
 * Native yolo rewrites ask→allow on every surface, including
 * external_directory, while leaving explicit deny rules untouched.
 */
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

	pi.on("session_start", (_event, ctx) => {
		enabled = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (
				entry.type === "custom" &&
				entry.customType === STATE_TYPE &&
				typeof entry.data?.enabled === "boolean"
			) {
				enabled = entry.data.enabled;
			}
		}

		try {
			setNativeYoloMode(enabled);
		} catch {
			ctx.ui.notify(
				"YOLO could not update the permission-system native yolo setting.",
				"warning",
			);
		}
		updateStatus(ctx);
	});

	pi.registerCommand("yolo", {
		description: "Toggle automatic approval while preserving hard denials",
		handler: async (args, ctx) => {
			const requested = args.trim().toLowerCase();
			if (requested && requested !== "on" && requested !== "off") {
				ctx.ui.notify("Usage: /yolo [on|off]", "warning");
				return;
			}

			const nextEnabled = requested ? requested === "on" : !enabled;
			try {
				setNativeYoloMode(nextEnabled);
			} catch (error) {
				ctx.ui.notify(
					`YOLO could not update permission-system config: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}

			enabled = nextEnabled;
			pi.appendEntry(STATE_TYPE, { enabled });
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
