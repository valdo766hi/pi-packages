import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const CONFIG_PATH = [
	"extensions",
	"pi-permission-system",
	"config.json",
] as const;
const LEGACY_CONFIG_PATH = ["pi-permissions.jsonc"] as const;
const STATE_DIRECTORY = ["yolo-state"] as const;
const STATE_VERSION = 1;

const CONFIG_DIRECTORY_MODE = 0o700;
const CONFIG_FILE_MODE = 0o600;
const STATE_DIRECTORY_MODE = 0o700;
const STATE_FILE_MODE = 0o600;
const permissionSystemRequire = createRequire(import.meta.url);

type JsonObject = Record<string, unknown>;

type PersistedYoloState = {
	version: number;
	sessionId: string;
	enabled: boolean;
};

type ConfigFile = { raw: string; config: JsonObject; path: string };

const NATIVE_CONFIG_KEYS = new Set([
	"$schema",
	"debugLog",
	"permissionReviewLog",
	"yoloMode",
	"doublePressToConfirm",
	"forwardingTimeoutMs",
	"toolInputPreviewMaxLength",
	"toolTextSummaryMaxLength",
	"piInfrastructureReadPaths",
	"authorizerChain",
	"permission",
	"shellTools",
]);
const PROMPT_CONFIG_KEYS = ["promptMaxRows", "promptFieldMaxWidth"] as const;
const PERMISSION_STATES = new Set(["allow", "deny", "ask"]);

function permissionConfigPath(): string {
	return join(getAgentDir(), ...CONFIG_PATH);
}

function legacyPermissionConfigPath(): string {
	return join(getAgentDir(), ...LEGACY_CONFIG_PATH);
}

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

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Strip comments without treating comment-like text inside strings as comments. */
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
			if (close === -1) {
				throw new Error("Unterminated block comment");
			}
			i = close + 2;
			continue;
		}

		output += char;
		i++;
	}

	return output;
}

function parseJsonObject(raw: string, label: string): JsonObject {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripJsonComments(raw));
	} catch (error) {
		throw new Error(`${label} is not valid JSON/JSONC: ${errorMessage(error)}`);
	}
	if (!isObject(parsed)) {
		throw new Error(`${label} must contain a JSON object`);
	}
	return parsed;
}

function invalidNativeConfig(path: string, message: string): never {
	throw new Error(
		`${path} is not a valid permission-system config: ${message}`,
	);
}

function assertNonEmptyString(
	value: unknown,
	label: string,
	path: string,
): void {
	if (typeof value !== "string" || value.length === 0) {
		invalidNativeConfig(path, `${label} must be a non-empty string`);
	}
}

function assertPermissionAction(
	value: unknown,
	label: string,
	path: string,
): void {
	if (typeof value === "string") {
		if (!PERMISSION_STATES.has(value)) {
			invalidNativeConfig(path, `${label} must be allow, deny, or ask`);
		}
		return;
	}
	if (!isObject(value)) {
		invalidNativeConfig(path, `${label} must be a permission action`);
	}
	const keys = Object.keys(value);
	if (keys.some((key) => key !== "action" && key !== "reason")) {
		invalidNativeConfig(path, `${label} contains an unknown key`);
	}
	if (value.action !== "deny") {
		invalidNativeConfig(path, `${label}.action must be deny`);
	}
	if (
		value.reason !== undefined &&
		(typeof value.reason !== "string" || value.reason.length > 500)
	) {
		invalidNativeConfig(path, `${label}.reason must be at most 500 characters`);
	}
}

function assertPermissionConfig(value: unknown, path: string): void {
	if (!isObject(value))
		invalidNativeConfig(path, "permission must be an object");
	for (const [surface, policy] of Object.entries(value)) {
		assertNonEmptyString(surface, "permission surface", path);
		if (typeof policy === "string") {
			assertPermissionAction(policy, `permission.${surface}`, path);
			continue;
		}
		if (!isObject(policy)) {
			invalidNativeConfig(
				path,
				`permission.${surface} must be an action or pattern map`,
			);
		}
		for (const [pattern, action] of Object.entries(policy)) {
			assertNonEmptyString(pattern, "permission pattern", path);
			assertPermissionAction(action, `permission.${surface}.${pattern}`, path);
		}
	}
}

function assertShellToolsConfig(value: unknown, path: string): void {
	if (!isObject(value))
		invalidNativeConfig(path, "shellTools must be an object");
	for (const [tool, alias] of Object.entries(value)) {
		assertNonEmptyString(tool, "shellTools key", path);
		if (!isObject(alias)) {
			invalidNativeConfig(path, `shellTools.${tool} must be an object`);
		}
		const keys = Object.keys(alias);
		if (
			keys.some((key) => key !== "commandArgument" && key !== "workdirArgument")
		) {
			invalidNativeConfig(path, `shellTools.${tool} contains an unknown key`);
		}
		assertNonEmptyString(
			alias.commandArgument,
			`shellTools.${tool}.commandArgument`,
			path,
		);
		if (alias.workdirArgument !== undefined) {
			assertNonEmptyString(
				alias.workdirArgument,
				`shellTools.${tool}.workdirArgument`,
				path,
			);
		}
	}
}

function assertNativeConfigShape(config: JsonObject, path: string): void {
	const allowedKeys = new Set(NATIVE_CONFIG_KEYS);
	if (supportsPromptConfig()) {
		for (const key of PROMPT_CONFIG_KEYS) allowedKeys.add(key);
	}
	const unknownKey = Object.keys(config).find((key) => !allowedKeys.has(key));
	if (unknownKey)
		invalidNativeConfig(path, `unknown top-level key '${unknownKey}'`);

	for (const key of [
		"debugLog",
		"permissionReviewLog",
		"yoloMode",
		"doublePressToConfirm",
	] as const) {
		if (config[key] !== undefined && typeof config[key] !== "boolean") {
			invalidNativeConfig(path, `${key} must be boolean`);
		}
	}
	const numericKeys = [
		"forwardingTimeoutMs",
		"toolInputPreviewMaxLength",
		"toolTextSummaryMaxLength",
	];
	if (supportsPromptConfig()) numericKeys.push(...PROMPT_CONFIG_KEYS);
	for (const key of numericKeys) {
		if (
			config[key] !== undefined &&
			(typeof config[key] !== "number" ||
				!Number.isSafeInteger(config[key]) ||
				config[key] < 1)
		) {
			invalidNativeConfig(path, `${key} must be a positive integer`);
		}
	}
	if (config.$schema !== undefined && typeof config.$schema !== "string") {
		invalidNativeConfig(path, "$schema must be a string");
	}
	for (const key of ["piInfrastructureReadPaths", "authorizerChain"] as const) {
		if (config[key] !== undefined) {
			if (
				!Array.isArray(config[key]) ||
				config[key].some(
					(value) => typeof value !== "string" || value.length === 0,
				)
			) {
				invalidNativeConfig(
					path,
					`${key} must be an array of non-empty strings`,
				);
			}
		}
	}
	if (config.permission !== undefined)
		assertPermissionConfig(config.permission, path);
	if (config.shellTools !== undefined)
		assertShellToolsConfig(config.shellTools, path);
}

function readConfigFile(path: string): ConfigFile {
	const raw = readFileSync(path, "utf8");
	const config = parseJsonObject(raw, path);
	assertNativeConfigShape(config, path);
	return { raw, config, path };
}

function readNativeConfig(): ConfigFile {
	return readConfigFile(permissionConfigPath());
}

function readOptionalConfigFile(path: string): ConfigFile | undefined {
	try {
		return readConfigFile(path);
	} catch (error) {
		if (isMissingFile(error)) return undefined;
		throw error;
	}
}

function findPermissionSystemPackageRoot(): string | undefined {
	let entry: string;
	try {
		entry = permissionSystemRequire.resolve("@gotgenes/pi-permission-system");
	} catch {
		return undefined;
	}

	let current = dirname(entry);
	for (let depth = 0; depth < 8; depth++) {
		const packagePath = join(current, "package.json");
		try {
			const packageJson = JSON.parse(
				readFileSync(packagePath, "utf8"),
			) as unknown;
			if (
				isObject(packageJson) &&
				packageJson.name === "@gotgenes/pi-permission-system"
			) {
				return current;
			}
		} catch {
			// Continue toward the filesystem root.
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return undefined;
}

function permissionSystemPackageRoots(): string[] {
	const roots = [
		join(
			getAgentDir(),
			"npm",
			"node_modules",
			"@gotgenes",
			"pi-permission-system",
		),
	];
	const packageRoot = findPermissionSystemPackageRoot();
	if (packageRoot) roots.push(packageRoot);
	return [...new Set(roots)];
}

function permissionSystemVersion():
	| { major: number; minor: number }
	| undefined {
	for (const root of permissionSystemPackageRoots()) {
		try {
			const packageJson = JSON.parse(
				readFileSync(join(root, "package.json"), "utf8"),
			) as unknown;
			if (!isObject(packageJson) || typeof packageJson.version !== "string") {
				continue;
			}
			const match = /^(\d+)\.(\d+)(?:\.|$)/.exec(packageJson.version);
			if (match) return { major: Number(match[1]), minor: Number(match[2]) };
		} catch {
			// Continue looking for another installed copy.
		}
	}
	return undefined;
}

function supportsPromptConfig(): boolean {
	const version = permissionSystemVersion();
	return Boolean(
		version &&
			(version.major > 25 || (version.major === 25 && version.minor >= 3)),
	);
}

function legacyExtensionConfigPaths(): string[] {
	return permissionSystemPackageRoots().map((root) =>
		join(root, "config.json"),
	);
}

function readLegacyExtensionConfigs(): ConfigFile[] {
	const configs: ConfigFile[] = [];
	for (const path of legacyExtensionConfigPaths()) {
		const config = readOptionalConfigFile(path);
		if (config) configs.push(config);
	}
	return configs;
}

function readLegacyGlobalConfig(): ConfigFile | undefined {
	return readOptionalConfigFile(legacyPermissionConfigPath());
}

function modeFromLegacyConfigs(
	configs: ConfigFile[],
	label: string,
): boolean | undefined {
	let mode: boolean | undefined;
	for (const config of configs) {
		const candidate = configuredYoloMode(config.config, config.path);
		if (candidate === undefined) continue;
		if (mode !== undefined && mode !== candidate) {
			throw new Error(`${label} configs disagree about yoloMode`);
		}
		mode = candidate;
	}
	return mode;
}

function configuredYoloMode(
	config: JsonObject,
	path: string,
): boolean | undefined {
	if (config.yoloMode === undefined) return undefined;
	if (typeof config.yoloMode !== "boolean") {
		throw new Error(`${path} must contain a boolean 'yoloMode' value`);
	}
	return config.yoloMode;
}

function readLegacyExtensionYoloMode(): boolean | undefined {
	return modeFromLegacyConfigs(
		readLegacyExtensionConfigs(),
		"Legacy extension permission",
	);
}

function readLegacyGlobalYoloMode(): boolean | undefined {
	const legacy = readLegacyGlobalConfig();
	return legacy ? configuredYoloMode(legacy.config, legacy.path) : undefined;
}

function readLegacyNativeYoloMode(): boolean | undefined {
	return readLegacyExtensionYoloMode() ?? readLegacyGlobalYoloMode();
}

function projectPermissionConfigPaths(ctx: ExtensionContext): string[] {
	return [
		join(ctx.cwd, ".pi", "extensions", "pi-permission-system", "config.json"),
		join(ctx.cwd, ".pi", "agent", "pi-permissions.jsonc"),
	];
}

function readProjectYoloMode(ctx: ExtensionContext): boolean | undefined {
	if (typeof ctx.isProjectTrusted !== "function") {
		throw new Error("Cannot verify whether the project is trusted");
	}
	if (!ctx.isProjectTrusted()) return undefined;

	let mode: boolean | undefined;
	for (const path of projectPermissionConfigPaths(ctx)) {
		let raw: string;
		try {
			raw = readFileSync(path, "utf8");
		} catch (error) {
			if (isMissingFile(error)) continue;
			throw error;
		}

		const config = parseJsonObject(raw, path);
		if (config.yoloMode === undefined) continue;
		if (typeof config.yoloMode !== "boolean") {
			throw new Error(`${path} must contain a boolean 'yoloMode' value`);
		}
		if (mode !== undefined && mode !== config.yoloMode) {
			throw new Error("Project permission configs disagree about yoloMode");
		}
		mode = config.yoloMode;
	}
	return mode;
}

function readNativeYoloMode(): boolean {
	let current: { raw: string; config: JsonObject } | undefined;
	try {
		current = readNativeConfig();
	} catch (error) {
		if (!isMissingFile(error)) throw error;
	}

	const currentMode = current
		? configuredYoloMode(current.config, permissionConfigPath())
		: undefined;
	const legacyMode = readLegacyNativeYoloMode();
	return currentMode ?? legacyMode ?? false;
}

/**
 * Replace the native config only after checking the source was not changed.
 * This is still not a cross-process transaction, but it avoids fixed temp-file
 * collisions and detects changes made before the replacement.
 */
function writeNativeConfig(
	configPath: string,
	nextConfig: JsonObject,
	metadata: ReturnType<typeof lstatSync> | undefined,
	expectedRaw: string | undefined,
): void {
	mkdirSync(dirname(configPath), {
		recursive: true,
		mode: CONFIG_DIRECTORY_MODE,
	});

	const tempPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
	let tempWritten = false;
	try {
		writeFileSync(tempPath, `${JSON.stringify(nextConfig, null, 2)}\n`, {
			encoding: "utf8",
			mode: metadata ? Number(metadata.mode) & 0o777 : CONFIG_FILE_MODE,
		});
		tempWritten = true;

		try {
			const currentMetadata = lstatSync(configPath);
			if (currentMetadata.isSymbolicLink()) {
				throw new Error(
					`Refusing to replace symlinked permission config: ${configPath}`,
				);
			}
			if (expectedRaw === undefined) {
				throw new Error(
					"Permission-system config appeared while YOLO was creating it",
				);
			}
			if (readFileSync(configPath, "utf8") !== expectedRaw) {
				throw new Error(
					"Permission-system config changed while YOLO was updating it",
				);
			}
		} catch (error) {
			if (isMissingFile(error) && expectedRaw === undefined) {
				// The config did not exist when we began and is still absent.
			} else if (isMissingFile(error)) {
				throw new Error(
					"Permission-system config disappeared while YOLO was updating it",
				);
			} else {
				throw error;
			}
		}

		renameSync(tempPath, configPath);
		tempWritten = false;

		const committed = readConfigFile(configPath);
		if (
			configuredYoloMode(committed.config, configPath) !== nextConfig.yoloMode
		) {
			throw new Error(
				"Permission-system config changed before YOLO could verify the update",
			);
		}
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

/**
 * Update only the native scalar toggle. Permission rules are copied unchanged.
 * Legacy global config is supported by writing a higher-precedence new config
 * override when necessary.
 */
function setNativeYoloMode(enabled: boolean): boolean {
	const configPath = permissionConfigPath();
	let native: { raw: string; config: JsonObject } | undefined;
	try {
		native = readNativeConfig();
	} catch (error) {
		if (!isMissingFile(error)) throw error;
	}

	const legacyMode = readLegacyNativeYoloMode();
	if (!native) {
		if (legacyMode === enabled) return false;
		if (legacyMode === undefined) {
			if (!enabled) return false;
			throw new Error(`Permission-system config is missing: ${configPath}`);
		}
		writeNativeConfig(configPath, { yoloMode: enabled }, undefined, undefined);
		return true;
	}

	const currentMode = configuredYoloMode(native.config, configPath);
	const effectiveMode = currentMode ?? legacyMode ?? false;
	if (effectiveMode === enabled) return false;

	const metadata = lstatSync(configPath);
	if (metadata.isSymbolicLink()) {
		throw new Error(
			`Refusing to replace symlinked permission config: ${configPath}`,
		);
	}
	writeNativeConfig(
		configPath,
		{ ...native.config, yoloMode: enabled },
		metadata,
		native.raw,
	);
	return true;
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
					sessionId: ctx.sessionManager.getSessionId(),
					enabled,
				} satisfies PersistedYoloState,
				null,
			)}\n`,
			{
				encoding: "utf8",
				mode: STATE_FILE_MODE,
			},
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

export default function (pi: ExtensionAPI): void {
	let enabled = false;
	// No lifecycle event has established a safe state yet.
	let stateKnown = false;

	const updateStatus = (ctx: ExtensionContext): void => {
		let status = "YOLO: ERROR";
		if (stateKnown) status = enabled ? "YOLO: ON" : "YOLO: OFF";
		ctx.ui.setStatus("yolo", status);
	};

	const syncStatus = (ctx: ExtensionContext): boolean => {
		let desired = false;
		let stateError: unknown;
		try {
			desired = readPersistedYoloMode(ctx);
		} catch (error) {
			stateError = error;
		}

		try {
			const projectMode = readProjectYoloMode(ctx);
			if (projectMode !== undefined && projectMode !== desired) {
				throw new Error(
					`Trusted project config sets yoloMode=${projectMode}; it conflicts with this session's yoloMode=${desired}`,
				);
			}
		} catch (error) {
			stateError ??= error;
		}

		try {
			setNativeYoloMode(stateError ? false : desired);
		} catch (error) {
			stateKnown = false;
			enabled = false;
			ctx.ui.notify(
				`YOLO could not establish a safe state: ${errorMessage(error)}`,
				"warning",
			);
			updateStatus(ctx);
			return false;
		}

		if (stateError) {
			stateKnown = false;
			enabled = false;
			ctx.ui.notify(
				`YOLO state is invalid: ${errorMessage(stateError)}`,
				"warning",
			);
		} else {
			stateKnown = true;
			enabled = desired;
		}
		updateStatus(ctx);
		return stateKnown;
	};

	pi.on("session_start", (_event, ctx) => {
		syncStatus(ctx);
	});
	pi.on("input", (event, ctx) => {
		const safe = syncStatus(ctx);
		const isYoloCommand =
			event.text === "/yolo" || event.text.startsWith("/yolo ");
		if (!safe && !isYoloCommand) {
			return { action: "handled" };
		}
	});
	pi.on("before_agent_start", (_event, ctx) => {
		if (!syncStatus(ctx)) ctx.abort();
	});
	// Some extension-triggered turns do not pass through the input handler.
	// Reconcile again at agent/turn boundaries and abort when safety is unknown.
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
		if (!stateKnown) {
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

	pi.registerCommand("yolo", {
		description:
			"Toggle automatic approval while preserving native effective denials",
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
				const projectMode = readProjectYoloMode(ctx);
				if (projectMode !== undefined && projectMode !== nextEnabled) {
					throw new Error(
						`Trusted project config sets yoloMode=${projectMode}; remove that override before using /yolo ${nextEnabled ? "on" : "off"}`,
					);
				}
			} catch (error) {
				ctx.ui.notify(
					`YOLO cannot override project yoloMode: ${errorMessage(error)}`,
					"error",
				);
				return;
			}

			let previousNative: boolean | undefined;
			let nativeChanged = false;
			try {
				previousNative = readNativeYoloMode();
				nativeChanged = setNativeYoloMode(nextEnabled);
				writePersistedYoloMode(ctx, nextEnabled);
			} catch (error) {
				if (nativeChanged && previousNative !== undefined) {
					try {
						setNativeYoloMode(previousNative);
					} catch (rollbackError) {
						ctx.ui.notify(
							`YOLO rollback failed: ${errorMessage(rollbackError)}`,
							"error",
						);
					}
				}
				ctx.ui.notify(
					`YOLO could not update its state: ${errorMessage(error)}`,
					"error",
				);
				syncStatus(ctx);
				return;
			}

			stateKnown = true;
			enabled = nextEnabled;
			updateStatus(ctx);
			ctx.ui.notify(
				`YOLO mode ${enabled ? "on" : "off"}. Native effective denials remain enforced.`,
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
