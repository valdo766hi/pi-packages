// Renders footer.ts through a minimal stand-in for pi's extension and TUI APIs.
// Run with: node --test footer.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import footerExtension, { renderBar } from "./footer.ts";

const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function assistant(input: number, output: number, cacheRead = 0, cost = 0) {
	return {
		type: "message",
		message: { role: "assistant", usage: { input, output, cacheRead, cacheWrite: 0, cost: { total: cost } } },
	};
}

function setup(statuses: Record<string, string> = {}, providers = 1) {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const entries = [assistant(1_200_000, 84_000, 900, 0.5)];
	let factory: any;
	const ctx = {
		mode: "tui",
		model: { id: "gpt-6-luna", provider: "openai-codex", reasoning: true, contextWindow: 258_000 },
		thinkingLevel: "max",
		getContextUsage: () => ({ tokens: 108_000, contextWindow: 258_000, percent: 41.86 }),
		sessionManager: {
			getCwd: () => "/Users/someone/.config/nix",
			getSessionName: () => undefined,
			getEntries: () => entries,
		},
		ui: { setFooter: (next: any) => (factory = next) },
	};
	footerExtension({
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerCommand: () => {},
	} as any);
	handlers.get("session_start")!({}, ctx);

	const component = factory(
		{ requestRender() {} },
		plain,
		{
			onBranchChange: () => () => {},
			getGitBranch: () => "main",
			getAvailableProviderCount: () => providers,
			getExtensionStatuses: () => new Map(Object.entries(statuses)),
		},
	);
	return { entries, render: (width: number) => component.render(width) as string[] };
}

test("wide footer shows location, model, context, usage, and active chips on two lines", () => {
	const { render } = setup({ fast: "\u{f0e7} FAST: ON", yolo: "YOLO: ON", other: "lsp ok" });
	const lines = render(120);
	assert.equal(lines.length, 2);
	for (const line of lines) assert.equal(visibleWidth(line), 120);
	assert.match(lines[0], /^nix · ⎇ main +gpt-6-luna ● max$/);
	assert.match(lines[1], /^━+[╸─│]* {2}42% {2}108k\/258k +↑1\.2M ↓84k {2}◎ 0% {2}\$0\.50 {2}⚡ fast {2}⚠ yolo {2}lsp ok$/);
});

test("OFF toggles are hidden and narrow terminals shed detail before the bar", () => {
	const { render } = setup({ fast: "\u{f0e7} FAST: OFF", yolo: "YOLO: ON" });
	assert.doesNotMatch(render(120)[1], /fast|FAST/);

	const medium = render(44);
	for (const line of medium) assert.ok(visibleWidth(line) <= 44, line);
	assert.match(medium[1], /^[━╸─│]+ {2}42% {2}108k\/258k +↑1\.2M ↓84k {2}⚠ yolo$/);

	const narrow = render(32);
	for (const line of narrow) assert.ok(visibleWidth(line) <= 32, line);
	assert.match(narrow[1], /^[━╸─│]+ {2}42% {2}108k\/258k +⚠ yolo$/);

	const tiny = render(20);
	for (const line of tiny) assert.ok(visibleWidth(line) <= 20, line);
	assert.match(tiny[1], /^42% +⚠$/);
});

test("line 1 drops the provider prefix before truncating the model", () => {
	const { render } = setup({}, 2);
	assert.match(render(120)[0], /openai-codex\/gpt-6-luna \u25cf max$/);
	assert.match(render(34)[0], /^nix \u00b7 \u2387 main +gpt-6-luna \u25cf max$/);
});

test("usage totals refresh when the session grows", () => {
	const { entries, render } = setup();
	assert.match(render(120)[1], /↑1\.2M ↓84k/);
	entries.push(assistant(800_000, 16_000));
	assert.match(render(120)[1], /↑2\.0M ↓100k/);
});

test("bar fills in half cells and marks the compaction point", () => {
	assert.equal(renderBar(plain, 0.5, 10, 0.95), "━━━━━────│");
	assert.equal(renderBar(plain, 0.25, 10, 0), "━━╸───────");
	assert.equal(renderBar(plain, null, 4, 0), "────");
});
