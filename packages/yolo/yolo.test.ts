import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import yoloExtension from "./yolo.ts";

function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

test("session startup preserves the native setting and commands update it atomically", async () => {
	const agentDir = tempDir("pi-yolo-");
	const configDir = join(agentDir, "extensions", "pi-permission-system");
	mkdirSync(configDir, { recursive: true });
	const configPath = join(configDir, "config.json");
	writeFileSync(configPath, '{"yoloMode":true}\n');

	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;

	try {
		const handlers = new Map<string, (event: any, ctx: any) => any>();
		const commands = new Map<string, any>();
		let appendCalls = 0;
		let reloads = 0;
		let status = "";
		const ctx = {
			sessionManager: {
				getBranch: () => [
					{
						type: "custom",
						customType: "yolo-state",
						data: { enabled: false },
					},
				],
			},
			ui: {
				setStatus: (_key: string, value: string) => {
					status = value;
				},
				notify() {},
			},
			reload: async () => {
				reloads += 1;
			},
		};
		const pi = {
			on: (event: string, handler: any) => handlers.set(event, handler),
			registerCommand: (name: string, command: any) =>
				commands.set(name, command),
			appendEntry: () => {
				appendCalls += 1;
			},
		};

		yoloExtension(pi as any);
		const sessionStart = handlers.get("session_start");
		const beforeAgentStart = handlers.get("before_agent_start");
		const sessionCompact = handlers.get("session_compact");
		assert.ok(sessionStart);
		assert.ok(beforeAgentStart);
		assert.ok(sessionCompact);
		sessionStart!({}, ctx);
		beforeAgentStart!({}, ctx);
		sessionCompact!({}, ctx);
		assert.equal(JSON.parse(readFileSync(configPath, "utf8")).yoloMode, true);
		assert.equal(status, "YOLO: ON");

		const yolo = commands.get("yolo");
		assert.ok(yolo);
		await yolo.handler("off", ctx);
		assert.equal(JSON.parse(readFileSync(configPath, "utf8")).yoloMode, false);
		assert.equal(reloads, 1);
		assert.equal(appendCalls, 0);

		await yolo.handler("on", ctx);
		assert.equal(JSON.parse(readFileSync(configPath, "utf8")).yoloMode, true);
		assert.equal(reloads, 2);
		assert.equal(status, "YOLO: ON");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});
