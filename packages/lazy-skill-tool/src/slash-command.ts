import type {
	ExtensionAPI,
	ExtensionCommandContext,
	Skill,
	SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import { dirname, isAbsolute, resolve } from "node:path";
import type { SkillSnapshot } from "./snapshot.ts";

interface CompletionItem {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
}

interface AutocompleteSuggestions {
	readonly items: CompletionItem[];
	readonly prefix: string;
}

interface AutocompleteProvider {
	readonly triggerCharacters?: string[];
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null>;
	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: CompletionItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number };
	shouldTriggerFileCompletion?(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): boolean;
}

export interface LazyCommandArguments {
	readonly name: string;
	readonly args: string;
}

function skillName(command: SlashCommandInfo): string | undefined {
	if (command.source !== "skill" || !command.name.startsWith("skill:")) {
		return undefined;
	}
	return command.name.slice("skill:".length);
}

export function canonicalSkillCommands(
	pi: Pick<ExtensionAPI, "getCommands">,
): ReadonlyMap<string, SlashCommandInfo> {
	const commands = new Map<string, SlashCommandInfo>();
	for (const command of pi.getCommands()) {
		const name = skillName(command);
		if (name === undefined || commands.has(name)) continue;
		commands.set(name, command);
	}
	return commands;
}

/** Build an explicit-command-only bootstrap snapshot input from Pi's command registry. */
export function skillsFromCanonicalCommands(
	pi: Pick<ExtensionAPI, "getCommands">,
	cwd: string,
): Skill[] {
	return [...canonicalSkillCommands(pi).entries()].flatMap(([name, command]) => {
		if (!command.description) return [];
		const sourcePath = isAbsolute(command.sourceInfo.path)
			? command.sourceInfo.path
			: resolve(cwd, command.sourceInfo.path);
		const sourceBase = command.sourceInfo.baseDir;
		let baseDir = dirname(sourcePath);
		if (sourceBase) {
			baseDir = isAbsolute(sourceBase) ? sourceBase : resolve(cwd, sourceBase);
		}
		return [
			{
				name,
				description: command.description,
				filePath: sourcePath,
				baseDir,
				sourceInfo: Object.freeze({
					...command.sourceInfo,
					path: sourcePath,
					baseDir,
				}),
				disableModelInvocation: false,
			},
		];
	});
}

export function parseLazyCommandArguments(
	args: string,
): LazyCommandArguments | undefined {
	const normalized = args.trimStart();
	if (!normalized) return undefined;
	const separator = normalized.indexOf(" ");
	return {
		name: separator === -1 ? normalized : normalized.slice(0, separator),
		args: separator === -1 ? "" : normalized.slice(separator + 1),
	};
}

function nativeSyntaxSupported(name: string): boolean {
	return name.length > 0 && !name.includes(" ");
}

function sourceLabel(command: SlashCommandInfo): string {
	return `${command.sourceInfo.scope}/${command.sourceInfo.source}`;
}

function compareNames(
	left: { readonly name: string },
	right: { readonly name: string },
): number {
	if (left.name < right.name) return -1;
	if (left.name > right.name) return 1;
	return 0;
}

function policyDescription(
	name: string,
	command: SlashCommandInfo,
	snapshot: SkillSnapshot | undefined,
): string {
	const description = command.description ?? "";
	let action = "deny";
	if (snapshot?.policy.valid) action = snapshot.policy.decision(name);
	const suffix = [sourceLabel(command), action === "ask" ? "ask" : undefined]
		.filter(Boolean)
		.join(", ");
	return suffix ? `${description} [${suffix}]` : description;
}

function visibleCommandEntries(
	pi: Pick<ExtensionAPI, "getCommands">,
	snapshot: SkillSnapshot | undefined,
): Array<{ name: string; command: SlashCommandInfo }> {
	if (!snapshot?.policy.valid) return [];
	const entries: Array<{ name: string; command: SlashCommandInfo }> = [];
	for (const [name, command] of canonicalSkillCommands(pi)) {
		if (snapshot.policy.decision(name) === "deny") continue;
		entries.push({ name, command });
	}
	return entries.toSorted(compareNames);
}

function commandCompletions(
	pi: Pick<ExtensionAPI, "getCommands">,
	snapshot: SkillSnapshot | undefined,
	prefix: string,
): CompletionItem[] {
	const completions: CompletionItem[] = [];
	for (const { name, command } of visibleCommandEntries(pi, snapshot)) {
		if (!nativeSyntaxSupported(name) || !name.startsWith(prefix)) continue;
		completions.push({
			value: name,
			label: name,
			description: policyDescription(name, command, snapshot),
		});
	}
	return completions;
}

function notifyFailure(ctx: ExtensionCommandContext, message: string): void {
	ctx.ui.notify(message, "error");
}

async function selectSkill(
	pi: Pick<ExtensionAPI, "getCommands">,
	ctx: ExtensionCommandContext,
	snapshot: SkillSnapshot | undefined,
): Promise<string | undefined> {
	if (!ctx.hasUI) {
		notifyFailure(ctx, "Usage: /lazy-skill <name> [arguments...]");
		return undefined;
	}
	const entries = visibleCommandEntries(pi, snapshot);
	if (entries.length === 0) {
		notifyFailure(
			ctx,
			snapshot?.policy.valid === false
				? "[POLICY_INVALID] Skill loading is blocked because policy configuration is invalid."
				: "No policy-visible skills are available.",
		);
		return undefined;
	}
	const choices = new Map<string, string>();
	for (const { name, command } of entries) {
		const unsupported = nativeSyntaxSupported(name)
			? ""
			: " [unsupported: name contains a space]";
		const label = `${name} — ${policyDescription(name, command, snapshot)}${unsupported}`;
		choices.set(label, name);
	}
	const selected = await ctx.ui.select("Load skill", [...choices.keys()]);
	if (!selected) return undefined;
	const name = choices.get(selected);
	if (name && !nativeSyntaxSupported(name)) {
		notifyFailure(
			ctx,
			"This skill name is unsupported by Pi's native slash syntax.",
		);
		return undefined;
	}
	return name;
}

export function registerLazySkillCommand(
	pi: ExtensionAPI,
	getSnapshot: () => SkillSnapshot | undefined,
): void {
	pi.registerCommand("lazy-skill", {
		description: "Load a canonical skill by exact name",
		getArgumentCompletions(argumentPrefix) {
			if (argumentPrefix.includes(" ")) return null;
			return commandCompletions(pi, getSnapshot(), argumentPrefix);
		},
		async handler(args, ctx) {
			let parsed = parseLazyCommandArguments(args);
			if (!parsed) {
				const selected = await selectSkill(pi, ctx, getSnapshot());
				if (!selected) return;
				parsed = { name: selected, args: "" };
			}
			if (!nativeSyntaxSupported(parsed.name)) {
				notifyFailure(
					ctx,
					"This skill name is unsupported by Pi's native slash syntax.",
				);
				return;
			}
			if (!canonicalSkillCommands(pi).has(parsed.name)) {
				notifyFailure(ctx, "Skill is not available.");
				return;
			}
			pi.sendUserMessage(
				`/skill:${parsed.name}${parsed.args.length > 0 ? ` ${parsed.args}` : ""}`,
				{
					...(ctx.isIdle() ? {} : { deliverAs: "followUp" as const }),
					expandPromptTemplates: true,
				},
			);
		},
	});
}

export function installLazySkillAutocomplete(
	ctx: Pick<ExtensionCommandContext, "ui">,
	pi: Pick<ExtensionAPI, "getCommands">,
	getSnapshot: () => SkillSnapshot | undefined,
): void {
	ctx.ui.addAutocompleteProvider((current) => {
		const provider = current as AutocompleteProvider;
		return {
			triggerCharacters: [
				...new Set([...(provider.triggerCharacters ?? []), ":"]),
			],
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const line = lines[cursorLine] ?? "";
				const beforeCursor = line.slice(0, cursorCol);
				const match = /^\/lazy-skill:([^ ]*)$/u.exec(beforeCursor);
				if (!match) {
					return provider.getSuggestions(lines, cursorLine, cursorCol, options);
				}
				const namePrefix = match[1] ?? "";
				const items = commandCompletions(pi, getSnapshot(), namePrefix).map(
					(item) => ({ ...item, value: `/lazy-skill:${item.value}` }),
				);
				return { items, prefix: beforeCursor };
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				if (!prefix.startsWith("/lazy-skill:")) {
					return provider.applyCompletion(
						lines,
						cursorLine,
						cursorCol,
						item,
						prefix,
					);
				}
				const nextLines = [...lines];
				const line = nextLines[cursorLine] ?? "";
				const start = Math.max(0, cursorCol - prefix.length);
				nextLines[cursorLine] =
					line.slice(0, start) + item.value + line.slice(cursorCol);
				return {
					lines: nextLines,
					cursorLine,
					cursorCol: start + item.value.length,
				};
			},
			...(provider.shouldTriggerFileCompletion
				? {
						shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
							return provider.shouldTriggerFileCompletion!(
								lines,
								cursorLine,
								cursorCol,
							);
						},
					}
				: {}),
		};
	});
}
