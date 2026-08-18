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

test("the last explicit toggle survives native config rewrites and lifecycle events", async () => {
	const agentDir = tempDir("pi-yolo-");
	const configDir = join(agentDir, "extensions", "pi-permission-system");
	mkdirSync(configDir, { recursive: true });
	const configPath = join(configDir, "config.json");
	const statePath = join(agentDir, "yolo-state.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			yoloMode: false,
			permission: { bash: { "*": "ask", "rm *": "deny" } },
		}) + "\n",
	);

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
		const input = handlers.get("input");
		const beforeAgentStart = handlers.get("before_agent_start");
		const sessionCompact = handlers.get("session_compact");
		assert.ok(sessionStart);
		assert.ok(input);
		assert.ok(beforeAgentStart);
		assert.ok(sessionCompact);

		// No persisted state means the default is OFF, even if old session
		// history contains a stale yolo-state entry.
		sessionStart!({}, ctx);
		input!({}, ctx);
		beforeAgentStart!({}, ctx);
		sessionCompact!({}, ctx);
		assert.equal(JSON.parse(readFileSync(configPath, "utf8")).yoloMode, false);
		assert.equal(JSON.parse(readFileSync(statePath, "utf8")).enabled, false);
		assert.equal(status, "YOLO: OFF");

		const yolo = commands.get("yolo");
		assert.ok(yolo);
		await yolo.handler("on", ctx);
		assert.equal(JSON.parse(readFileSync(configPath, "utf8")).yoloMode, true);
		assert.equal(JSON.parse(readFileSync(statePath, "utf8")).enabled, true);
		assert.equal(
			JSON.parse(readFileSync(configPath, "utf8")).permission.bash["rm *"],
			"deny",
		);
		assert.equal(reloads, 1);
		assert.equal(appendCalls, 0);

		// A declarative config rewrite cannot erase the last explicit toggle.
		const rewrittenConfig = JSON.parse(readFileSync(configPath, "utf8"));
		rewrittenConfig.yoloMode = false;
		writeFileSync(configPath, `${JSON.stringify(rewrittenConfig)}\n`);
		sessionCompact!({}, ctx);
		assert.equal(JSON.parse(readFileSync(configPath, "utf8")).yoloMode, true);
		assert.equal(status, "YOLO: ON");

		await yolo.handler("off", ctx);
		assert.equal(JSON.parse(readFileSync(configPath, "utf8")).yoloMode, false);
		assert.equal(JSON.parse(readFileSync(statePath, "utf8")).enabled, false);
		assert.equal(reloads, 2);

		// The last OFF wins even if the native config is externally set to true.
		const externallyEnabled = JSON.parse(readFileSync(configPath, "utf8"));
		externallyEnabled.yoloMode = true;
		writeFileSync(configPath, `${JSON.stringify(externallyEnabled)}\n`);
		sessionStart!({}, ctx);
		assert.equal(JSON.parse(readFileSync(configPath, "utf8")).yoloMode, false);
		assert.equal(status, "YOLO: OFF");

		// A missing state file during upgrade migrates the existing native value.
		rmSync(statePath);
		externallyEnabled.yoloMode = true;
		writeFileSync(configPath, `${JSON.stringify(externallyEnabled)}\n`);
		sessionStart!({}, ctx);
		assert.equal(JSON.parse(readFileSync(statePath, "utf8")).enabled, true);
		assert.equal(status, "YOLO: ON");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});
