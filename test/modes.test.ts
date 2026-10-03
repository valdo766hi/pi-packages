import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import fastExtension from "../packages/fast/fast.ts";
import footerExtension from "../packages/footer/footer.ts";
import yoloExtension from "../packages/yolo/yolo.ts";

test("YOLO toggles preserve fast and footer state without reloading extensions", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-modes-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	mock.method(SettingsManager, "create", () => SettingsManager.inMemory());
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	const commands = new Map<string, any>();
	const statuses = new Map<string, string>();
	let footer: unknown;
	let reloads = 0;
	const ctx = {
		mode: "tui", cwd: agentDir, isProjectTrusted: () => false,
		sessionManager: { getSessionId: () => "modes-session" },
		ui: {
			setStatus: (key: string, value: string) => statuses.set(key, value),
			setFooter: (value: unknown) => { footer = value; },
			notify() {}, select: async () => undefined, custom: async () => undefined,
		},
		reload: async () => {
			reloads++;
			for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
		},
	};
	const pi = {
		on: (name: string, handler: any) => {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerCommand: (name: string, command: any) => commands.set(name, command),
		events: { on: () => () => {} },
	};
	try {
		fastExtension(pi as any);
		footerExtension(pi as any);
		yoloExtension(pi as any);
		for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
		await commands.get("fast").handler("on", ctx);
		await commands.get("footer").handler("", ctx);
		assert.equal(footer, undefined);
		for (const value of ["on", "off"]) {
			await commands.get("yolo").handler(value, ctx);
			assert.match(statuses.get("fast")!, /FAST: ON$/);
			assert.equal(footer, undefined);
			assert.equal(statuses.get("yolo"), `YOLO: ${value.toUpperCase()}`);
		}
		assert.equal(reloads, 0);
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
		mock.restoreAll();
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	}
});
