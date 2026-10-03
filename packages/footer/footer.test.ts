// Renders footer.ts through a minimal stand-in for pi's extension and TUI APIs.
// Run with: node --test footer.test.ts

import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import footerExtension, { renderBar } from "./footer.ts";

type Settings = NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>;
afterEach(() => mock.restoreAll());
const createSettings = SettingsManager.create;

const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function assistant(input: number, output: number, cacheRead = 0, cost = 0) {
	return {
		type: "message",
		message: { role: "assistant", usage: { input, output, cacheRead, cacheWrite: 0, cost: { total: cost } } },
	};
}

function setup(statuses: Record<string, string> = {}, providers = 1, options: {
	cwd?: string; settings?: Settings; trusted?: boolean;
} = {}) {
	mock.method(SettingsManager, "create", () => SettingsManager.inMemory(options.settings));
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const entries = [assistant(1_200_000, 84_000, 900, 0.5)];
	let factory: any;
	const ctx = {
		mode: "tui",
		cwd: options.cwd ?? "/Users/someone/.config/nix",
		isProjectTrusted: () => options.trusted ?? true,
		model: { id: "gpt-6-luna", provider: "openai-codex", reasoning: true, contextWindow: 258_000 },
		thinkingLevel: "max" as string | undefined,
		getContextUsage: () => ({ tokens: 108_000, contextWindow: 258_000, percent: 41.86 }),
		sessionManager: {
			getCwd: () => ctx.cwd,
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
	return {
		entries, ctx, render: (width: number) => component.render(width) as string[],
		refresh: () => handlers.get("before_agent_start")!({}, ctx),
	};
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

test("reasoning models without a thinking level display off, not undefined", () => {
	const footer = setup();
	footer.ctx.thinkingLevel = undefined;
	assert.match(footer.render(120)[0]!, /● off$/);
});

test("bar fills in half cells and marks the compaction point", () => {
	assert.equal(renderBar(plain, 0.5, 10, 0.95), "━━━━━────│");
	assert.equal(renderBar(plain, 0.25, 10, 0), "━━╸───────");
	assert.equal(renderBar(plain, null, 4, 0), "────");
});

test("project labels handle Windows drive and UNC paths", () => {
	for (const cwd of [String.raw`C:\work\project`, String.raw`\\server\share\project`]) {
		assert.match(setup({}, 1, { cwd }).render(120)[0], /^project ·/);
	}
});

test("the marker honors custom reserves, host model overrides, and disabled compaction", () => {
	const compaction = {
		reserveTokens: 32_768,
		modelOverrides: { "openai-codex/gpt-6-luna": { reserveTokens: 50_000 } },
	};
	const settings: Settings = { compaction };
	const footer = setup({}, 1, { settings });
	footer.ctx.getContextUsage = () => ({ tokens: 0, contextWindow: 100_000, percent: 0 });
	const native = SettingsManager.inMemory(settings);
	const reserve = Reflect.apply(native.getCompactionSettings, native, [footer.ctx.model]).reserveTokens;
	assert.equal(footer.render(120)[1]!.split("  ")[0]!.indexOf("│"), Math.floor((1 - reserve / 100_000) * 24));
	const disabled = setup({}, 1, { settings: { compaction: { enabled: false } } });
	assert.ok(!disabled.render(120)[1]!.includes("│"));
});

test("settings refresh from global and trusted project files without changing them", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-footer-settings-"));
	const agentDir = join(directory, "agent");
	const cwd = join(directory, "project");
	mkdirSync(agentDir);
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	const globalPath = join(agentDir, "settings.json");
	const projectPath = join(cwd, ".pi", "settings.json");
	writeFileSync(globalPath, JSON.stringify({ compaction: { reserveTokens: 32_768 } }));
	writeFileSync(projectPath, JSON.stringify({ compaction: { reserveTokens: 50_000 } }));
	try {
		for (const trusted of [true, false]) {
			const footer = setup({}, 1, { cwd, trusted });
			mock.method(SettingsManager, "create", (...args: Parameters<typeof SettingsManager.create>) => createSettings(cwd, agentDir, args[2]));
			footer.ctx.getContextUsage = () => ({ tokens: 0, contextWindow: 100_000, percent: 0 });
			footer.refresh();
			assert.equal(footer.render(120)[1]!.split("  ")[0]!.indexOf("│"), trusted ? 12 : 16);
		}
		assert.deepEqual(JSON.parse(readFileSync(globalPath, "utf8")), { compaction: { reserveTokens: 32_768 } });
		assert.deepEqual(JSON.parse(readFileSync(projectPath, "utf8")), { compaction: { reserveTokens: 50_000 } });
		writeFileSync(globalPath, JSON.stringify({ compaction: { enabled: false } }));
		const footer = setup({}, 1, { cwd, trusted: false });
		mock.method(SettingsManager, "create", (...args: Parameters<typeof SettingsManager.create>) => createSettings(cwd, agentDir, args[2]));
		footer.refresh();
		assert.ok(!footer.render(120)[1]!.includes("│"));
		writeFileSync(globalPath, "{invalid");
		footer.refresh();
		assert.ok(!footer.render(120)[1]!.includes("│"), "invalid settings must not invent a marker");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
