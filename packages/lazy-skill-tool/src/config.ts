import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { LazySkillError } from "./errors.ts";
import {
	compileSkillPolicy,
	invalidSkillPolicy,
	type CompiledSkillPolicy,
	type SkillPermissionAction,
	type SkillPermissionConfig,
	type SkillPermissionRule,
} from "./policy.ts";

export const DEFAULT_DESCRIPTION_MAX = 0;
export const DEFAULT_FILE_LIMIT = 0;
export const DEFAULT_MAX_SOURCE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_CATALOG_TOKEN_BUDGET = 4096;
export const MIN_MAX_SOURCE_BYTES = 1024;
export const MAX_MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_DESCRIPTION_MAX = 1024;
const MAX_FILE_LIMIT = 50;
const MAX_CATALOG_TOKEN_BUDGET = 100_000;

export type SkillRoutingMode = "safe" | "full" | "adaptive";

export interface LazySkillConfig {
	readonly routing: SkillRoutingMode;
	readonly permission: {
		readonly skill: SkillPermissionConfig;
	};
	readonly maxDescriptionCharacters: number;
	readonly maxSourceBytes: number;
	readonly resourceFileSampleLimit: number;
	/** Zero means the full policy-visible catalog always fits. */
	readonly catalogTokenBudget: number;
	/** @deprecated Use maxDescriptionCharacters. */
	readonly descriptionMax: number;
	/** @deprecated Use resourceFileSampleLimit. */
	readonly fileLimit: number;
	readonly disabled: boolean;
}

export interface ConfigResult {
	readonly config: LazySkillConfig;
	readonly policy: CompiledSkillPolicy;
	readonly warnings: readonly string[];
	readonly configPaths: readonly string[];
	readonly error?: LazySkillError;
}

interface ParsedFileConfig {
	readonly routing?: SkillRoutingMode;
	readonly skillPermission?: SkillPermissionAction | SkillPermissionConfig;
	readonly maxDescriptionCharacters?: number;
	readonly maxSourceBytes?: number;
	readonly resourceFileSampleLimit?: number;
	readonly catalogTokenBudget?: number;
}

interface MutableResolvedConfig {
	routing: SkillRoutingMode;
	defaultAction: SkillPermissionAction;
	rules: SkillPermissionRule[];
	maxDescriptionCharacters: number;
	maxSourceBytes: number;
	resourceFileSampleLimit: number;
	catalogTokenBudget: number;
	disabled: boolean;
}

type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

class JsonConfigParser {
	private index = 0;
	private readonly text: string;

	constructor(text: string) {
		this.text = text;
	}

	parse(): JsonValue {
		const value = this.parseValue("$");
		this.skipWhitespace();
		if (this.index !== this.text.length) this.fail("unexpected trailing content");
		return value;
	}

	private parseValue(path: string): JsonValue {
		this.skipWhitespace();
		const character = this.text[this.index];
		if (character === "{") return this.parseObject(path);
		if (character === "[") return this.parseArray(path);
		if (character === '"') return this.parseString();
		return this.parsePrimitive();
	}

	private parseObject(path: string): Record<string, JsonValue> {
		this.index += 1;
		const value: Record<string, JsonValue> = Object.create(null) as Record<
			string,
			JsonValue
		>;
		const keys = new Set<string>();
		this.skipWhitespace();
		if (this.text[this.index] === "}") {
			this.index += 1;
			return value;
		}
		while (this.index < this.text.length) {
			this.skipWhitespace();
			if (this.text[this.index] !== '"') this.fail("expected an object key");
			const key = this.parseString();
			if (keys.has(key))
				throw new Error(`${path}: duplicate field ${JSON.stringify(key)}`);
			keys.add(key);
			this.skipWhitespace();
			if (this.text[this.index] !== ":")
				this.fail("expected ':' after an object key");
			this.index += 1;
			value[key] = this.parseValue(`${path}.${key}`);
			this.skipWhitespace();
			const separator = this.text[this.index];
			if (separator === "}") {
				this.index += 1;
				return value;
			}
			if (separator !== ",") this.fail("expected ',' or '}'");
			this.index += 1;
		}
		this.fail("unterminated object");
	}

	private parseArray(path: string): JsonValue[] {
		this.index += 1;
		const value: JsonValue[] = [];
		this.skipWhitespace();
		if (this.text[this.index] === "]") {
			this.index += 1;
			return value;
		}
		while (this.index < this.text.length) {
			value.push(this.parseValue(`${path}[${value.length}]`));
			this.skipWhitespace();
			const separator = this.text[this.index];
			if (separator === "]") {
				this.index += 1;
				return value;
			}
			if (separator !== ",") this.fail("expected ',' or ']'");
			this.index += 1;
		}
		this.fail("unterminated array");
	}

	private parseString(): string {
		const start = this.index;
		this.index += 1;
		while (this.index < this.text.length) {
			const character = this.text[this.index];
			if (character === "\\") {
				this.index += 2;
				continue;
			}
			this.index += 1;
			if (character === '"') {
				try {
					return JSON.parse(this.text.slice(start, this.index)) as string;
				} catch {
					this.fail("invalid string");
				}
			}
		}
		this.fail("unterminated string");
	}

	private parsePrimitive(): JsonValue {
		const start = this.index;
		while (
			this.index < this.text.length &&
			!/[ \t\r\n,\]}]/u.test(this.text[this.index] ?? "")
		) {
			this.index += 1;
		}
		if (start === this.index) this.fail("expected a JSON value");
		try {
			return JSON.parse(this.text.slice(start, this.index)) as JsonValue;
		} catch {
			this.fail("invalid JSON value");
		}
	}

	private skipWhitespace(): void {
		while (/[ \t\r\n]/u.test(this.text[this.index] ?? "")) this.index += 1;
	}

	private fail(message: string): never {
		throw new Error(`${message} at character ${this.index + 1}`);
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownFields(
	value: Record<string, unknown>,
	allowed: ReadonlySet<string>,
	path: string,
): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`${path}.${key}: unsupported field`);
	}
}

function parseAction(value: unknown, path: string): SkillPermissionAction {
	if (value === "allow" || value === "ask" || value === "deny") return value;
	throw new Error(`${path}: expected "allow", "ask", or "deny"`);
}

function parseInteger(
	value: unknown,
	path: string,
	minimum: number,
	maximum: number,
): number {
	if (
		!Number.isInteger(value) ||
		(value as number) < minimum ||
		(value as number) > maximum
	) {
		throw new Error(`${path}: expected an integer from ${minimum} to ${maximum}`);
	}
	return value as number;
}

function parsePermission(
	value: unknown,
	path: string,
): SkillPermissionAction | SkillPermissionConfig {
	if (typeof value === "string") return parseAction(value, path);
	if (!isObject(value))
		throw new Error(`${path}: expected a permission action or object`);
	rejectUnknownFields(value, new Set(["default", "rules"]), path);
	const defaultAction =
		value.default === undefined
			? undefined
			: parseAction(value.default, `${path}.default`);
	let rules: SkillPermissionRule[] | undefined;
	if (value.rules !== undefined) {
		if (!Array.isArray(value.rules))
			throw new Error(`${path}.rules: expected an array`);
		rules = value.rules.map((entry, index) => {
			const rulePath = `${path}.rules[${index}]`;
			if (!isObject(entry)) throw new Error(`${rulePath}: expected an object`);
			rejectUnknownFields(entry, new Set(["pattern", "action"]), rulePath);
			if (typeof entry.pattern !== "string" || entry.pattern.length === 0) {
				throw new Error(`${rulePath}.pattern: expected a non-empty string`);
			}
			return {
				pattern: entry.pattern,
				action: parseAction(entry.action, `${rulePath}.action`),
			};
		});
	}
	return {
		...(defaultAction === undefined ? {} : { default: defaultAction }),
		...(rules === undefined ? {} : { rules }),
	};
}

function parseConfigTextUnchecked(
	text: string,
	configPath: string,
): ParsedFileConfig {
	let value: unknown;
	try {
		value = new JsonConfigParser(text).parse();
	} catch (error) {
		throw new Error(
			`${configPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!isObject(value)) throw new Error(`${configPath}: root must be an object`);
	rejectUnknownFields(
		value,
		new Set([
			"$schema",
			"routing",
			"permission",
			"maxDescriptionCharacters",
			"maxSourceBytes",
			"resourceFileSampleLimit",
			"catalogTokenBudget",
		]),
		"$",
	);
	if (value.$schema !== undefined && typeof value.$schema !== "string") {
		throw new Error(`${configPath}: $.$schema must be a string`);
	}
	let routing: SkillRoutingMode | undefined;
	if (value.routing !== undefined) {
		if (
			value.routing !== "safe" &&
			value.routing !== "full" &&
			value.routing !== "adaptive"
		) {
			throw new Error(
				`${configPath}: $.routing must be "safe", "full", or "adaptive"`,
			);
		}
		routing = value.routing;
	}
	let skillPermission: SkillPermissionAction | SkillPermissionConfig | undefined;
	if (value.permission !== undefined) {
		if (!isObject(value.permission))
			throw new Error(`${configPath}: $.permission must be an object`);
		rejectUnknownFields(value.permission, new Set(["skill"]), "$.permission");
		if (value.permission.skill !== undefined) {
			skillPermission = parsePermission(
				value.permission.skill,
				"$.permission.skill",
			);
		}
	}
	return {
		...(routing === undefined ? {} : { routing }),
		...(skillPermission === undefined ? {} : { skillPermission }),
		...(value.maxDescriptionCharacters === undefined
			? {}
			: {
					maxDescriptionCharacters: parseInteger(
						value.maxDescriptionCharacters,
						"$.maxDescriptionCharacters",
						0,
						MAX_DESCRIPTION_MAX,
					),
				}),
		...(value.maxSourceBytes === undefined
			? {}
			: {
					maxSourceBytes: parseInteger(
						value.maxSourceBytes,
						"$.maxSourceBytes",
						MIN_MAX_SOURCE_BYTES,
						MAX_MAX_SOURCE_BYTES,
					),
				}),
		...(value.resourceFileSampleLimit === undefined
			? {}
			: {
					resourceFileSampleLimit: parseInteger(
						value.resourceFileSampleLimit,
						"$.resourceFileSampleLimit",
						0,
						MAX_FILE_LIMIT,
					),
				}),
		...(value.catalogTokenBudget === undefined
			? {}
			: {
					catalogTokenBudget: parseInteger(
						value.catalogTokenBudget,
						"$.catalogTokenBudget",
						0,
						MAX_CATALOG_TOKEN_BUDGET,
					),
				}),
	};
}

export function parseConfigText(
	text: string,
	configPath = "lazy-skill.json",
): ParsedFileConfig {
	try {
		return parseConfigTextUnchecked(text, configPath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.startsWith(`${configPath}:`)) throw error;
		throw new Error(`${configPath}: ${message}`, { cause: error });
	}
}

function defaults(): MutableResolvedConfig {
	return {
		routing: "adaptive",
		defaultAction: "allow",
		rules: [],
		maxDescriptionCharacters: DEFAULT_DESCRIPTION_MAX,
		maxSourceBytes: DEFAULT_MAX_SOURCE_BYTES,
		resourceFileSampleLimit: DEFAULT_FILE_LIMIT,
		catalogTokenBudget: DEFAULT_CATALOG_TOKEN_BUDGET,
		disabled: false,
	};
}

function applyFileConfig(
	target: MutableResolvedConfig,
	source: ParsedFileConfig,
): void {
	if (source.routing !== undefined) target.routing = source.routing;
	if (source.maxDescriptionCharacters !== undefined) {
		target.maxDescriptionCharacters = source.maxDescriptionCharacters;
	}
	if (source.maxSourceBytes !== undefined)
		target.maxSourceBytes = source.maxSourceBytes;
	if (source.resourceFileSampleLimit !== undefined) {
		target.resourceFileSampleLimit = source.resourceFileSampleLimit;
	}
	if (source.catalogTokenBudget !== undefined) {
		target.catalogTokenBudget = source.catalogTokenBudget;
	}
	if (typeof source.skillPermission === "string") {
		target.defaultAction = source.skillPermission;
	} else if (source.skillPermission) {
		if (source.skillPermission.default !== undefined) {
			target.defaultAction = source.skillPermission.default;
		}
		target.rules.push(...(source.skillPermission.rules ?? []));
	}
}

function envInteger(
	target: MutableResolvedConfig,
	env: NodeJS.ProcessEnv,
	key: string,
	field:
		| "maxDescriptionCharacters"
		| "maxSourceBytes"
		| "resourceFileSampleLimit",
	minimum: number,
	maximum: number,
	warnings: string[],
): void {
	const raw = env[key];
	if (raw === undefined) return;
	const value = Number(raw.trim());
	if (!Number.isInteger(value) || value < minimum || value > maximum) {
		warnings.push(
			`${key} must be an integer from ${minimum} to ${maximum}; keeping ${target[field]}.`,
		);
		return;
	}
	target[field] = value;
}

function applyEnvironment(
	target: MutableResolvedConfig,
	env: NodeJS.ProcessEnv,
	warnings: string[],
): void {
	if (
		env.PI_LAZY_SKILL_DESCRIPTION_MAX !== undefined ||
		env.PI_LAZY_SKILL_FILE_LIMIT !== undefined
	) {
		warnings.push(
			"PI_LAZY_SKILL_DESCRIPTION_MAX and PI_LAZY_SKILL_FILE_LIMIT are deprecated compatibility overrides; prefer maxDescriptionCharacters and resourceFileSampleLimit in lazy-skill.json.",
		);
	}
	const routing = env.PI_LAZY_SKILL_ROUTING?.trim().toLowerCase();
	if (routing === "safe" || routing === "full" || routing === "adaptive") {
		target.routing = routing;
	} else if (routing !== undefined) {
		warnings.push(
			`PI_LAZY_SKILL_ROUTING must be safe, full, or adaptive; keeping ${target.routing}.`,
		);
	}
	envInteger(
		target,
		env,
		"PI_LAZY_SKILL_DESCRIPTION_MAX",
		"maxDescriptionCharacters",
		0,
		MAX_DESCRIPTION_MAX,
		warnings,
	);
	envInteger(
		target,
		env,
		"PI_LAZY_SKILL_MAX_SOURCE_BYTES",
		"maxSourceBytes",
		MIN_MAX_SOURCE_BYTES,
		MAX_MAX_SOURCE_BYTES,
		warnings,
	);
	envInteger(
		target,
		env,
		"PI_LAZY_SKILL_FILE_LIMIT",
		"resourceFileSampleLimit",
		0,
		MAX_FILE_LIMIT,
		warnings,
	);
	const disabled = env.PI_LAZY_SKILL_DISABLE;
	if (disabled !== undefined) {
		if (/^(1|true|yes)$/iu.test(disabled.trim())) target.disabled = true;
		else if (/^(0|false|no)$/iu.test(disabled.trim())) target.disabled = false;
		else
			warnings.push(
				"PI_LAZY_SKILL_DISABLE must be 1/true/yes or 0/false/no; keeping false.",
			);
	}
}

function finish(
	target: MutableResolvedConfig,
	warnings: string[],
	configPaths: string[],
): ConfigResult {
	if (target.routing === "full")
		warnings.push(
			'Routing mode "full" is deprecated and is an alias for "safe".',
		);
	if (target.maxDescriptionCharacters > 0) {
		warnings.push(
			"Description truncation opts out of safe mode's complete-description routing guarantee.",
		);
	}
	const permission: SkillPermissionConfig = {
		default: target.defaultAction,
		rules: Object.freeze(target.rules.map((rule) => Object.freeze({ ...rule }))),
	};
	const policy = compileSkillPolicy({
		defaultAction: target.defaultAction,
		rules: target.rules,
	});
	return {
		config: Object.freeze({
			routing: target.routing,
			permission: Object.freeze({ skill: Object.freeze(permission) }),
			maxDescriptionCharacters: target.maxDescriptionCharacters,
			maxSourceBytes: target.maxSourceBytes,
			resourceFileSampleLimit: target.resourceFileSampleLimit,
			catalogTokenBudget: target.catalogTokenBudget,
			descriptionMax: target.maxDescriptionCharacters,
			fileLimit: target.resourceFileSampleLimit,
			disabled: target.disabled,
		}),
		policy,
		warnings: Object.freeze(warnings),
		configPaths: Object.freeze(configPaths),
	};
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ConfigResult {
	const target = defaults();
	const warnings: string[] = [];
	applyEnvironment(target, env, warnings);
	return finish(target, warnings, []);
}

async function readOptionalConfig(
	configPath: string,
): Promise<ParsedFileConfig | undefined> {
	let text: string;
	try {
		text = await readFile(configPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`${configPath}: unable to read configuration`, {
			cause: error,
		});
	}
	return parseConfigText(text, configPath);
}

export interface LoadConfigOptions {
	readonly cwd: string;
	readonly projectTrusted: boolean;
	readonly env?: NodeJS.ProcessEnv;
	readonly agentDir?: string;
}

export async function loadConfig(
	options: LoadConfigOptions,
): Promise<ConfigResult> {
	const target = defaults();
	const warnings: string[] = [];
	const configPaths: string[] = [];
	const globalPath = join(options.agentDir ?? getAgentDir(), "lazy-skill.json");
	const projectPath = join(options.cwd, CONFIG_DIR_NAME, "lazy-skill.json");
	try {
		const globalConfig = await readOptionalConfig(globalPath);
		if (globalConfig) {
			configPaths.push(globalPath);
			applyFileConfig(target, globalConfig);
		}
		if (options.projectTrusted) {
			const projectConfig = await readOptionalConfig(projectPath);
			if (projectConfig) {
				configPaths.push(projectPath);
				applyFileConfig(target, projectConfig);
			}
		}
		applyEnvironment(target, options.env ?? process.env, warnings);
		return finish(target, warnings, configPaths);
	} catch (cause) {
		const diagnostic = cause instanceof Error ? cause.message : String(cause);
		const error = new LazySkillError("POLICY_INVALID", {
			configPath: diagnostic.startsWith(projectPath) ? projectPath : globalPath,
			diagnostics: [diagnostic],
			cause,
		});
		const fallback = finish(target, warnings, configPaths);
		return {
			...fallback,
			policy: invalidSkillPolicy([diagnostic]),
			error,
		};
	}
}
