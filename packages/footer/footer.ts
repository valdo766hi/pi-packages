// @ts-nocheck -- Pi provides its extension types and Node globals at runtime.
// Custom footer — replaces the built-in two-line footer with a context usage bar.
//
// Line 1: cwd · git branch · session name          provider/model · thinking level
// Line 2: [context bar] percent tokens/window      ↑in ↓out Rcache Wcache CHhit% $cost
// Line 3: extension statuses (only when any extension called ctx.ui.setStatus)
//
// The bar and the percentage share one zone colour (green → yellow → red) driven
// by current usage, and the bar marks the point where auto-compaction triggers,
// so the remaining headroom is readable at a glance.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Mirrors pi's default `compaction.reserveTokens`; auto-compaction fires past it. */
const COMPACTION_RESERVE_TOKENS = 16_384;

const BAR_MIN_CELLS = 10;
const BAR_MAX_CELLS = 28;

/** Sub-cell fills, 1/8 through 7/8 of a cell. */
const PARTIAL_CELLS = ["▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const FULL_CELL = "█";
const EMPTY_CELL = "░";
const COMPACT_MARK = "╎";

const WARN_AT = 0.7;
const DANGER_AT = 0.9;

const SEPARATOR = " · ";

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

/** Matches pi's built-in footer token formatting. */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function zoneColor(fillRatio: number): string {
	if (fillRatio > DANGER_AT) return "error";
	if (fillRatio > WARN_AT) return "warning";
	return "success";
}

function thinkingColor(level: string): string {
	switch (level) {
		case "minimal":
			return "thinkingMinimal";
		case "low":
			return "thinkingLow";
		case "medium":
			return "thinkingMedium";
		case "high":
			return "thinkingHigh";
		case "xhigh":
			return "thinkingXhigh";
		case "max":
			return "thinkingMax";
		default:
			return "thinkingOff";
	}
}

/**
 * Render the context bar. `ratio` is null when context size is unknown
 * (right after compaction, before the next assistant response).
 */
function renderBar(theme: any, ratio: number | null, cells: number, markRatio: number): string {
	const filledEighths = ratio === null ? 0 : Math.round(clamp01(ratio) * cells * 8);
	const markIndex =
		markRatio > 0 && markRatio < 1 ? Math.min(cells - 1, Math.floor(markRatio * cells)) : -1;

	// The whole filled run shares the percentage's colour, so bar and number agree.
	const fillColor = ratio === null ? "dim" : zoneColor(ratio);

	// Accumulate runs of same-coloured cells so one escape sequence covers each run.
	const parts: string[] = [];
	let runColor: string | null = null;
	let runText = "";
	const flush = () => {
		if (runText) parts.push(theme.fg(runColor, runText));
		runText = "";
	};

	for (let i = 0; i < cells; i++) {
		const eighths = Math.min(8, Math.max(0, filledEighths - i * 8));
		let char: string;
		let color: string;
		if (eighths === 8) {
			char = FULL_CELL;
			color = fillColor;
		} else if (eighths > 0) {
			char = PARTIAL_CELLS[eighths - 1];
			color = fillColor;
		} else if (i === markIndex) {
			char = COMPACT_MARK;
			color = "muted";
		} else {
			char = EMPTY_CELL;
			color = "dim";
		}
		if (color !== runColor) {
			flush();
			runColor = color;
		}
		runText += char;
	}
	flush();
	return parts.join("");
}

/** Pad `left` and `right` to exactly `width`, truncating the right side first. */
function joinLeftRight(left: string, right: string, width: number, theme: any): string {
	const leftWidth = visibleWidth(left);
	if (leftWidth >= width) return truncateToWidth(left, width, theme.fg("dim", "…"));
	if (!right) return left;

	const rightWidth = visibleWidth(right);
	const gap = width - leftWidth - rightWidth;
	if (gap >= 2) return left + " ".repeat(gap) + right;

	const available = width - leftWidth - 2;
	if (available <= 0) return left;
	const truncated = truncateToWidth(right, available, "");
	const pad = Math.max(0, width - leftWidth - visibleWidth(truncated));
	return left + " ".repeat(pad) + truncated;
}

function formatCwd(theme: any, cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	let path = cwd;
	if (home && (cwd === home || cwd.startsWith(`${home}/`))) {
		path = cwd === home ? "~" : `~/${cwd.slice(home.length + 1)}`;
	}
	const cut = path.lastIndexOf("/");
	if (cut <= 0) return theme.fg("text", path);
	// Dim the parents, keep the current directory legible.
	return theme.fg("dim", `${path.slice(0, cut + 1)}`) + theme.fg("text", path.slice(cut + 1));
}

/**
 * Cumulative token/cost stats across the whole session, matching pi's built-in footer.
 * Returns a full and a compact variant; narrow terminals use the compact one so the
 * context bar keeps its space.
 */
function collectStats(ctx: any, theme: any): { full: string; compact: string } {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	let lastHitRate: number | undefined;

	const add = (u: any) => {
		if (!u) return;
		input += u.input ?? 0;
		output += u.output ?? 0;
		cacheRead += u.cacheRead ?? 0;
		cacheWrite += u.cacheWrite ?? 0;
		cost += u.cost?.total ?? 0;
	};

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			add(entry.message.usage);
			const prompt =
				(entry.message.usage?.input ?? 0) +
				(entry.message.usage?.cacheRead ?? 0) +
				(entry.message.usage?.cacheWrite ?? 0);
			lastHitRate = prompt > 0 ? ((entry.message.usage?.cacheRead ?? 0) / prompt) * 100 : undefined;
		} else if (entry.type === "message" && entry.message.role === "toolResult") {
			add(entry.message.usage);
		} else if (entry.type === "branch_summary" || entry.type === "compaction") {
			add(entry.usage);
		}
	}

	const io: string[] = [];
	if (input) io.push(`↑${formatTokens(input)}`);
	if (output) io.push(`↓${formatTokens(output)}`);

	const cache: string[] = [];
	if (cacheRead) cache.push(`R${formatTokens(cacheRead)}`);
	if (cacheWrite) cache.push(`W${formatTokens(cacheWrite)}`);
	if ((cacheRead > 0 || cacheWrite > 0) && lastHitRate !== undefined) {
		cache.push(`CH${lastHitRate.toFixed(0)}%`);
	}

	const costStr = cost > 0 ? theme.fg("muted", `$${cost.toFixed(3)}`) : "";
	const compose = (parts: string[]) => {
		const dimmed = parts.length > 0 ? theme.fg("dim", parts.join(" ")) : "";
		if (!costStr) return dimmed;
		return dimmed ? `${dimmed} ${costStr}` : costStr;
	};

	return { full: compose([...io, ...cache]), compact: compose(io) };
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

export default function (pi: ExtensionAPI) {
	const install = (ctx: any) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					if (width < 8) return [];

					// ---- line 1: location -------------------------------------------------
					const locationParts = [formatCwd(theme, ctx.sessionManager.getCwd())];
					const branch = footerData.getGitBranch();
					if (branch) locationParts.push(theme.fg("success", branch));
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) locationParts.push(theme.fg("muted", sessionName));
					const location = locationParts.join(theme.fg("dim", SEPARATOR));

					const model = ctx.model;
					let modelStr = theme.fg("accent", model?.id || "no-model");
					if (model && footerData.getAvailableProviderCount() > 1) {
						modelStr = theme.fg("dim", `${model.provider}/`) + modelStr;
					}
					if (model?.reasoning) {
						const level = ctx.thinkingLevel || pi.getThinkingLevel?.() || "off";
						const label = level === "off" ? "thinking off" : level;
						modelStr += theme.fg("dim", SEPARATOR) + theme.fg(thinkingColor(level), label);
					}

					// ---- line 2: context bar + usage stats --------------------------------
					const usage = ctx.getContextUsage();
					const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? 0;
					const ratio = usage && usage.percent !== null ? usage.percent / 100 : null;

					const percentText = (ratio === null ? "?%" : `${(ratio * 100).toFixed(1)}%`).padStart(5);
					const percentStr =
						ratio === null ? theme.fg("muted", percentText) : theme.bold(theme.fg(zoneColor(ratio), percentText));
					const tokensStr = theme.fg(
						"dim",
						`${usage?.tokens != null ? formatTokens(usage.tokens) : "?"}/${formatTokens(contextWindow)}`,
					);

					// Give the bar whatever horizontal room is left, dropping the cache stats
					// before the bar itself when the terminal is narrow.
					const stats = collectStats(ctx, theme);
					const reserved = visibleWidth(percentStr) + visibleWidth(tokensStr) + 8;
					const cellsFor = (right: string) =>
						Math.min(BAR_MAX_CELLS, width - reserved - visibleWidth(right));

					let statsStr = stats.full;
					let cells = cellsFor(statsStr);
					if (cells < BAR_MIN_CELLS && cellsFor(stats.compact) >= BAR_MIN_CELLS) {
						statsStr = stats.compact;
						cells = cellsFor(statsStr);
					}

					const markRatio =
						contextWindow > COMPACTION_RESERVE_TOKENS
							? (contextWindow - COMPACTION_RESERVE_TOKENS) / contextWindow
							: 0;

					const contextLeft =
						cells >= BAR_MIN_CELLS
							? `${renderBar(theme, ratio, cells, markRatio)}  ${percentStr} ${tokensStr}`
							: `${percentStr} ${tokensStr}`;

					const lines = [
						joinLeftRight(location, modelStr, width, theme),
						joinLeftRight(contextLeft, statsStr, width, theme),
					];

					// ---- line 3: extension statuses ---------------------------------------
					const statuses = footerData.getExtensionStatuses();
					if (statuses.size > 0) {
						const line = Array.from(statuses.entries())
							.sort(([a]: [string, string], [b]: [string, string]) => a.localeCompare(b))
							.map(([, text]: [string, string]) => sanitizeStatusText(text))
							.join(" ");
						lines.push(truncateToWidth(line, width, theme.fg("dim", "…")));
					}

					return lines;
				},
			};
		});
	};

	let enabled = true;

	pi.on("session_start", (_event, ctx) => {
		// Re-install per session so the closure never holds a stale session context.
		if (enabled) install(ctx);
	});

	pi.registerCommand("footer", {
		description: "Toggle the custom context-bar footer",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled) {
				install(ctx);
				ctx.ui.notify("Context-bar footer enabled", "info");
			} else {
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Built-in footer restored", "info");
			}
		},
	});
}
