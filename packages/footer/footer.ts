// Two-line footer: where you are and what is thinking, then context, usage, and
// active modes. Narrow terminals shed detail in a fixed order instead of wrapping.

import {
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { basename, win32 } from "node:path";

type FooterTheme = Pick<Theme, "fg" | "bold">;

const BAR_MIN_CELLS = 8;
const BAR_MAX_CELLS = 24;
const WARN_AT = 0.7;
const DANGER_AT = 0.9;
const GAP = "  ";

/** Known on/off statuses rendered as chips; any `<label>: OFF` status is hidden. */
const CHIPS: Record<string, { icon: string; label: string; color: ThemeColor }> = {
	fast: { icon: "⚡", label: "fast", color: "accent" },
	yolo: { icon: "⚠", label: "yolo", color: "warning" },
};

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function zoneColor(ratio: number): ThemeColor {
	if (ratio > DANGER_AT) return "error";
	if (ratio > WARN_AT) return "warning";
	return "success";
}

function thinkingColor(level: ExtensionContext["thinkingLevel"]): ThemeColor {
	const colors = {
		off: "thinkingOff", minimal: "thinkingMinimal", low: "thinkingLow",
		medium: "thinkingMedium", high: "thinkingHigh", xhigh: "thinkingXhigh", max: "thinkingMax",
	} as const;
	return colors[level ?? "off"] ?? "thinkingOff";
}

/** Thin bar in half-cell steps; `│` marks where auto-compaction triggers. */
export function renderBar(theme: FooterTheme, ratio: number | null, cells: number, markRatio: number): string {
	const halves = ratio === null ? 0 : Math.round(Math.min(1, Math.max(0, ratio)) * cells * 2);
	const full = Math.floor(halves / 2);
	const half = halves % 2;
	const markIndex = markRatio > 0 && markRatio < 1 ? Math.min(cells - 1, Math.floor(markRatio * cells)) : -1;
	const color = ratio === null ? "dim" : zoneColor(ratio);

	let empty = "";
	for (let i = full + half; i < cells; i++) {
		empty += i === markIndex ? theme.fg("muted", "│") : theme.fg("dim", "─");
	}
	return theme.fg(color, "━".repeat(full) + (half ? "╸" : "")) + empty;
}

/** Pad `left` and `right` to `width`, truncating the right side first. */
function joinLeftRight(left: string, right: string, width: number, theme: FooterTheme): string {
	const leftWidth = visibleWidth(left);
	if (leftWidth >= width) return truncateToWidth(left, width, theme.fg("dim", "…"));
	if (!right) return left;
	const room = width - leftWidth - 2;
	if (room <= 0) return left;
	const fitted = visibleWidth(right) <= room ? right : truncateToWidth(right, room, "");
	return left + " ".repeat(width - leftWidth - visibleWidth(fitted)) + fitted;
}

function projectName(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (home && cwd === home) return "~";
	return (win32.isAbsolute(cwd) && !cwd.startsWith("/") ? win32.basename(cwd) : basename(cwd)) || cwd;
}

function sanitize(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

/** Active modes as chips; known OFF toggles are hidden. `iconsOnly` keeps chips but drops their labels. */
function renderStatuses(theme: FooterTheme, statuses: ReadonlyMap<string, string>, iconsOnly: boolean): string {
	const chips: string[] = [];
	const others: string[] = [];
	for (const [key, raw] of [...statuses.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		const text = sanitize(raw);
		if (!text || /:\s*OFF$/i.test(text)) continue;
		const chip = CHIPS[key];
		if (chip && /:\s*ON$/i.test(text)) {
			chips.push(theme.fg(chip.color, iconsOnly ? chip.icon : `${chip.icon} ${chip.label}`));
		} else if (chip) {
			chips.push(theme.fg("error", text));
		} else if (!iconsOnly) {
			others.push(text);
		}
	}
	return [...chips, ...others].join(GAP);
}

type Totals = { input: number; output: number; cost: number; hitRate?: number };

/** Whole-session usage, cached by entry count because the session log only grows. */
function createUsageTotals() {
	let seen = -1;
	let totals: Totals = { input: 0, output: 0, cost: 0 };
	return (entries: readonly SessionEntry[]): Totals => {
		if (entries.length === seen) return totals;
		const next: Totals = { input: 0, output: 0, cost: 0 };
		const add = (u: Usage | undefined) => {
			if (!u) return;
			next.input += u.input ?? 0;
			next.output += u.output ?? 0;
			next.cost += u.cost?.total ?? 0;
		};
		for (const entry of entries) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				const u = entry.message.usage;
				add(u);
				const prompt = (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
				next.hitRate = prompt > 0 ? ((u?.cacheRead ?? 0) / prompt) * 100 : undefined;
			} else if (entry.type === "message" && entry.message.role === "toolResult") {
				add(entry.message.usage);
			} else if (entry.type === "branch_summary" || entry.type === "compaction") {
				add(entry.usage);
			}
		}
		seen = entries.length;
		totals = next;
		return totals;
	};
}

/** Right side of line 2, from most to least detailed; narrow terminals take later variants. */
function statsVariants(theme: FooterTheme, totals: Totals, statuses: ReadonlyMap<string, string>): string[] {
	const tokens = theme.fg("dim", `↑${formatTokens(totals.input)} ↓${formatTokens(totals.output)}`);
	const cache = totals.hitRate !== undefined ? theme.fg("dim", `◎ ${totals.hitRate.toFixed(0)}%`) : "";
	const cost = totals.cost > 0 ? theme.fg("muted", `$${totals.cost.toFixed(2)}`) : "";
	const hasUsage = totals.input > 0 || totals.output > 0;
	const chips = renderStatuses(theme, statuses, false);
	const icons = renderStatuses(theme, statuses, true);
	const join = (...parts: string[]) => parts.filter(Boolean).join(GAP);
	const usage = hasUsage ? tokens : "";
	return [
		join(usage, hasUsage ? cache : "", hasUsage ? cost : "", chips),
		join(usage, hasUsage ? cache : "", chips),
		join(usage, chips),
		chips,
		icons,
	];
}

export default function (pi: ExtensionAPI) {
	// Pi 0.85 ignores the model argument; Pi 1.0 resolves model overrides.
	let readCompaction: ((model: ExtensionContext["model"]) => ReturnType<SettingsManager["getCompactionSettings"]>) | undefined;
	const refreshSettings = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		const next = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
		readCompaction = next.drainErrors().length === 0 ? next.getCompactionSettings.bind(next) : undefined;
	};
	const install = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		refreshSettings(ctx);
		const usageTotals = createUsageTotals();

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					if (width < 8) return [];

					// ---- line 1: project · branch · session      model ● thinking
					const left1 = [theme.bold(theme.fg("text", projectName(ctx.sessionManager.getCwd())))];
					const branch = footerData.getGitBranch();
					if (branch) left1.push(theme.fg("success", `⎇ ${branch}`));
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) left1.push(theme.fg("muted", sessionName));

					const model = ctx.model;
					const modelId = theme.fg("accent", model?.id || "no model");
					const provider =
						model && footerData.getAvailableProviderCount() > 1 ? theme.fg("dim", `${model.provider}/`) : "";
					let thinking = "";
					if (model?.reasoning) {
						const level = ctx.thinkingLevel ?? "off";
						thinking = ` ${theme.fg(thinkingColor(level), `● ${level}`)}`;
					}
					const location = left1.join(theme.fg("dim", " · "));
					// Drop the provider prefix before truncating the model and thinking level.
					const room1 = width - visibleWidth(location) - 2;
					const right1 = visibleWidth(provider + modelId + thinking) <= room1 ? provider + modelId + thinking : modelId + thinking;

					// ---- line 2: context bar  percent  tokens      usage  chips
					const usage = ctx.getContextUsage();
					const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? 0;
					const ratio = usage && usage.percent != null ? usage.percent / 100 : null;
					const percent =
						ratio === null
							? theme.fg("muted", "?%")
							: theme.bold(theme.fg(zoneColor(ratio), `${Math.round(ratio * 100)}%`));
					const used = usage?.tokens != null ? formatTokens(usage.tokens) : "?";
					const window = theme.fg("dim", `${used}/${formatTokens(contextWindow)}`);
					const compaction = readCompaction?.(model);
					const markRatio = compaction?.enabled && contextWindow > compaction.reserveTokens
						? (contextWindow - compaction.reserveTokens) / contextWindow
						: 0;

					const variants = statsVariants(
						theme,
						usageTotals(ctx.sessionManager.getEntries()),
						footerData.getExtensionStatuses(),
					);
					const withBar = (cells: number) =>
						`${renderBar(theme, ratio, cells, markRatio)}${GAP}${percent}${GAP}${window}`;
					const barCells = (right: string) =>
						Math.min(BAR_MAX_CELLS, width - visibleWidth(withBar(0)) - visibleWidth(right) - 2);

					let line2 = "";
					for (const right of variants) {
						const cells = barCells(right);
						if (cells >= BAR_MIN_CELLS) {
							line2 = joinLeftRight(withBar(cells), right, width, theme);
							break;
						}
					}
					if (!line2) {
						// No room for the bar: keep the percentage and the most compact chips.
						line2 = joinLeftRight(percent, variants.at(-1) ?? "", width, theme);
					}

					return [joinLeftRight(location, right1, width, theme), line2];
				},
			};
		});
	};

	let enabled = true;

	pi.on("session_start", (_event, ctx) => {
		// Re-install per session so the closure never holds a stale session context.
		if (enabled) install(ctx);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		if (enabled) refreshSettings(ctx);
	});

	pi.registerCommand("footer", {
		description: "Toggle the custom footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled) {
				install(ctx);
				ctx.ui.notify("Custom footer enabled", "info");
			} else {
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Built-in footer restored", "info");
			}
		},
	});
}
