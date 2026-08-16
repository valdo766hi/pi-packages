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

test("yolo command atomically updates the native permission setting", async () => {
	const agentDir = tempDir("pi-yolo-");
	const configDir = join(agentDir, "extensions", "pi-permission-system");
	mkdirSync(configDir, { recursive: true });
	const configPath = join(configDir, "config.json");
	writeFileSync(configPath, '{"yoloMode":false}\n');

	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;

	try {
		const handlers = new Map<string, (event: any, ctx: any) => any>();
		const commands = new Map<string, any>();
		const entries: unknown[] = [];
		let reloads = 0;
		const ctx = {
			sessionManager: { getBranch: () => [] },
			ui: { setStatus() {}, notify() {} },
			reload: async () => {
				reloads += 1;
			},
		};
		const pi = {
			on: (event: string, handler: any) => handlers.set(event, handler),
			registerCommand: (name: string, command: any) =>
				commands.set(name, command),
			appendEntry: (_type: string, data: unknown) => entries.push(data),
		};

		yoloExtension(pi as any);
		const sessionStart = handlers.get("session_start");
		assert.ok(sessionStart);
		sessionStart!({}, ctx);
		assert.equal(JSON.parse(readFileSync(configPath, "utf8")).yoloMode, false);

		const yolo = commands.get("yolo");
		assert.ok(yolo);
		await yolo.handler("on", ctx);
		assert.equal(JSON.parse(readFileSync(configPath, "utf8")).yoloMode, true);
		assert.equal(reloads, 1);
		assert.deepEqual(entries, [{ enabled: true }]);

		await yolo.handler("off", ctx);
		assert.equal(JSON.parse(readFileSync(configPath, "utf8")).yoloMode, false);
		assert.equal(reloads, 2);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});
