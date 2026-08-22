import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const STATE_DIRECTORY = ["yolo-state"] as const;
const STATE_VERSION = 1;
const STATE_DIRECTORY_MODE = 0o700;
const STATE_FILE_MODE = 0o600;

type PersistedYoloState = {
	version: number;
	sessionId: string;
	enabled: boolean;
};

type YoloUi = {
	select(
		title: string,
		options: string[],
		dialogOptions?: unknown,
	): Promise<string | undefined>;
	custom(factory: unknown, options?: unknown): Promise<unknown>;
};

function stateDirectoryPath(): string {
	return join(getAgentDir(), ...STATE_DIRECTORY);
}

function statePath(ctx: ExtensionContext): string {
	const sessionId = ctx.sessionManager.getSessionId();
	if (!sessionId) {
		throw new Error("YOLO requires a persisted session identity");
	}
	return join(stateDirectoryPath(), `${encodeURIComponent(sessionId)}.json`);
}

function isMissingFile(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strip JSONC comments without treating comment-like text inside strings as comments. */
function stripJsonComments(input: string): string {
	let output = "";
	let i = 0;

	while (i < input.length) {
		const char = input[i];
		const next = input[i + 1] ?? "";

		if (char === '"') {
			let escaping = false;
			output += char;
			i++;
			while (i < input.length) {
				const stringChar = input[i];
				output += stringChar;
				i++;
				if (escaping) {
					escaping = false;
				} else if (stringChar === "\\") {
					escaping = true;
				} else if (stringChar === '"') {
					break;
				}
			}
			continue;
		}

		if (char === "/" && next === "/") {
			const newline = input.indexOf("\n", i + 2);
			output += newline === -1 ? "" : "\n";
			i = newline === -1 ? input.length : newline + 1;
			continue;
		}

		if (char === "/" && next === "*") {
			const close = input.indexOf("*/", i + 2);
			if (close === -1) throw new Error("Unterminated block comment");
			i = close + 2;
			continue;
		}

		output += char;
		i++;
	}

	return output;
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripJsonComments(raw));
	} catch (error) {
		throw new Error(`${label} is not valid JSON/JSONC: ${errorMessage(error)}`);
	}
	if (!isObject(parsed)) throw new Error(`${label} must contain a JSON object`);
	return parsed;
}

function readPersistedYoloMode(ctx: ExtensionContext): boolean {
	const path = statePath(ctx);
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return false;
		throw error;
	}

	const state = parseJsonObject(raw, path) as Partial<PersistedYoloState>;
	if (
		state.version !== STATE_VERSION ||
		state.sessionId !== ctx.sessionManager.getSessionId() ||
		typeof state.enabled !== "boolean"
	) {
		throw new Error(
			`${path} must contain version ${STATE_VERSION}, the current sessionId, and a boolean 'enabled' value`,
		);
	}
	return state.enabled;
}

function writePersistedYoloMode(ctx: ExtensionContext, enabled: boolean): void {
	const sessionId = ctx.sessionManager.getSessionId();
	if (!sessionId) throw new Error("YOLO requires a persisted session identity");

	const path = statePath(ctx);
	const directory = dirname(path);
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let tempWritten = false;
	try {
		mkdirSync(directory, { recursive: true, mode: STATE_DIRECTORY_MODE });
		writeFileSync(
			tempPath,
			`${JSON.stringify(
				{
					version: STATE_VERSION,
					sessionId,
					enabled,
				} satisfies PersistedYoloState,
				null,
			)}\n`,
			{ encoding: "utf8", mode: STATE_FILE_MODE },
		);
		tempWritten = true;
		renameSync(tempPath, path);
		tempWritten = false;
	} finally {
		if (tempWritten) {
			try {
				unlinkSync(tempPath);
			} catch {
				// Ignore cleanup failures.
			}
		}
	}
}

function isPermissionSelect(options: string[]): boolean {
	return (
		options[0] === "Yes" &&
		options.includes("No") &&
		options.includes("No, provide reason")
	);
}

function isPermissionCustomOptions(options: unknown): boolean {
	return isObject(options) && options.overlay === false;
}

type AutoApprovalDecision = {
	approved: true;
	state: "approved";
	autoApproved: true;
};

function autoApprovalDecision(): AutoApprovalDecision {
	return {
		approved: true,
		state: "approved",
		autoApproved: true,
	};
}

function patchPermissionUi(
	ctx: ExtensionContext,
	consumePrompt: () => boolean,
): () => void {
	// SAFETY: Pi exposes the same mutable UI object to permission prompts; this
	// narrow adapter wraps only its public select/custom methods.
	const ui = ctx.ui as unknown as YoloUi;
	const originalSelect = ui.select;
	const originalCustom = ui.custom;

	const wrappedSelect: YoloUi["select"] = (title, options, optionsConfig) => {
		if (isPermissionSelect(options) && consumePrompt()) {
			return Promise.resolve(options[0]);
		}
		return originalSelect.call(ui, title, options, optionsConfig);
	};
	const wrappedCustom: YoloUi["custom"] = (factory, options) => {
		if (isPermissionCustomOptions(options) && consumePrompt()) {
			return Promise.resolve(autoApprovalDecision());
		}
		return originalCustom.call(ui, factory, options);
	};

	ui.select = wrappedSelect;
	ui.custom = wrappedCustom;
	return () => {
		if (ui.select === wrappedSelect) ui.select = originalSelect;
		if (ui.custom === wrappedCustom) ui.custom = originalCustom;
	};
}

export default function (pi: ExtensionAPI): void {
	let enabled = false;
	let stateKnown = false;
	let permissionPromptPending = false;
	let promptTimer: ReturnType<typeof setTimeout> | undefined;
	let restoreUi: (() => void) | undefined;
	let activeContext: ExtensionContext | undefined;

	const updateStatus = (ctx: ExtensionContext): void => {
		let status = "YOLO: ERROR";
		if (stateKnown) status = enabled ? "YOLO: ON" : "YOLO: OFF";
		ctx.ui.setStatus("yolo", status);
	};

	const clearPendingPrompt = (): void => {
		permissionPromptPending = false;
		if (promptTimer !== undefined) {
			clearTimeout(promptTimer);
			promptTimer = undefined;
		}
	};

	const markPendingPrompt = (): void => {
		clearPendingPrompt();
		permissionPromptPending = true;
		promptTimer = setTimeout(clearPendingPrompt, 10_000);
	};

	const consumePendingPrompt = (): boolean => {
		if (!activeContext || !permissionPromptPending) return false;
		if (!syncStatus(activeContext) || !enabled) {
			clearPendingPrompt();
			return false;
		}
		clearPendingPrompt();
		return true;
	};

	const syncStatus = (ctx: ExtensionContext): boolean => {
		activeContext = ctx;
		const wasEnabled = stateKnown && enabled;
		try {
			const nextEnabled = readPersistedYoloMode(ctx);
			if (wasEnabled && !nextEnabled) {
				throw new Error("YOLO state was revoked or deleted during this session");
			}
			enabled = nextEnabled;
			stateKnown = true;
		} catch (error) {
			stateKnown = false;
			enabled = false;
			clearPendingPrompt();
			ctx.ui.notify(`YOLO state is invalid: ${errorMessage(error)}`, "warning");
		}
		updateStatus(ctx);
		return stateKnown;
	};

	const installUiPatch = (ctx: ExtensionContext): void => {
		restoreUi?.();
		restoreUi = patchPermissionUi(ctx, consumePendingPrompt);
	};

	const removePromptListeners = [
		pi.events.on("permissions:ui_prompt", () => {
			if (!activeContext || !syncStatus(activeContext)) return;
			if (enabled) markPendingPrompt();
		}),
		pi.events.on("permissions:decision", clearPendingPrompt),
	];

	pi.on("session_start", (_event, ctx) => {
		installUiPatch(ctx);
		syncStatus(ctx);
	});
	pi.on("input", (event, ctx) => {
		const safe = syncStatus(ctx);
		const isYoloCommand =
			event.text === "/yolo" || event.text.startsWith("/yolo ");
		if (!safe && !isYoloCommand) return { action: "handled" };
	});
	pi.on("before_agent_start", (_event, ctx) => {
		if (!syncStatus(ctx)) ctx.abort();
	});
	pi.on("agent_start", (_event, ctx) => {
		if (!syncStatus(ctx)) ctx.abort();
	});
	pi.on("turn_start", (_event, ctx) => {
		if (!syncStatus(ctx)) ctx.abort();
	});
	pi.on("session_compact", (_event, ctx) => {
		syncStatus(ctx);
	});
	pi.on("tool_call", (_event, ctx) => {
		const safe = stateKnown && syncStatus(ctx);
		if (!safe) {
			ctx.abort();
			return {
				block: true,
				terminate: true,
				reason:
					"YOLO cannot verify a safe permission state; resolve YOLO: ERROR first.",
			};
		}
		return undefined;
	});
	pi.on("session_shutdown", () => {
		clearPendingPrompt();
		restoreUi?.();
		restoreUi = undefined;
		activeContext = undefined;
		for (const remove of removePromptListeners) remove();
	});

	pi.registerCommand("yolo", {
		description: "Toggle automatic approval of native permission prompts",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const requested = args.trim().toLowerCase();
			if (requested && requested !== "on" && requested !== "off") {
				ctx.ui.notify("Usage: /yolo [on|off]", "warning");
				return;
			}

			let currentEnabled: boolean;
			try {
				currentEnabled = readPersistedYoloMode(ctx);
			} catch (error) {
				ctx.ui.notify(
					`YOLO could not read its session state: ${errorMessage(error)}`,
					"error",
				);
				return;
			}

			const nextEnabled = requested ? requested === "on" : !currentEnabled;
			try {
				writePersistedYoloMode(ctx, nextEnabled);
			} catch (error) {
				ctx.ui.notify(
					`YOLO could not update its state: ${errorMessage(error)}`,
					"error",
				);
				syncStatus(ctx);
				return;
			}

			stateKnown = true;
			enabled = nextEnabled;
			clearPendingPrompt();
			updateStatus(ctx);
			ctx.ui.notify(
				`YOLO overlay ${enabled ? "on" : "off"}. Permission-system config unchanged.`,
				enabled ? "warning" : "info",
			);

			try {
				await ctx.reload();
			} catch (error) {
				ctx.ui.notify(
					`YOLO state was saved, but Pi reload failed: ${errorMessage(error)}`,
					"warning",
				);
			}
		},
	});
}
