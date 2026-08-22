import assert from "node:assert/strict";
import {
	existsSync,
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

function configPath(agentDir: string): string {
	return join(agentDir, "extensions", "pi-permission-system", "config.json");
}

function statePath(agentDir: string, sessionId: string): string {
	return join(agentDir, "yolo-state", `${encodeURIComponent(sessionId)}.json`);
}

function setup(
	agentDir: string,
	sessionId: string,
	reload?: () => Promise<void>,
) {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const commands = new Map<string, any>();
	const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
	const notifications: string[] = [];
	let status = "";
	let reloads = 0;
	let aborts = 0;
	let selectCalls = 0;
	let customCalls = 0;

	const events = {
		on: (channel: string, handler: (data: unknown) => void) => {
			const listeners = eventHandlers.get(channel) ?? new Set();
			listeners.add(handler);
			eventHandlers.set(channel, listeners);
			return () => listeners.delete(handler);
		},
		emit: (channel: string, data: unknown) => {
			for (const handler of eventHandlers.get(channel) ?? []) handler(data);
		},
	};

	const ctx = {
		cwd: agentDir,
		isProjectTrusted: () => true,
		sessionManager: {
			getSessionId: () => sessionId,
		},
		ui: {
			setStatus: (_key: string, value: string) => {
				status = value;
			},
			notify: (message: string) => {
				notifications.push(message);
			},
			select: async (_title: string, options: string[]) => {
				selectCalls++;
				return options.at(-1);
			},
			custom: async (_factory: unknown, _options?: unknown) => {
				customCalls++;
				return { original: true };
			},
		},
		reload: async () => {
			reloads++;
			if (reload) await reload();
		},
		abort: () => {
			aborts++;
		},
	};
	const pi = {
		events,
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
	};

	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		yoloExtension(pi as any);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}

	return {
		ctx,
		events,
		handlers,
		command: (args = "") => commands.get("yolo")!.handler(args, ctx),
		notifications,
		reloads: () => reloads,
		aborts: () => aborts,
		selectCalls: () => selectCalls,
		customCalls: () => customCalls,
		status: () => status,
	};
}

async function withAgentDir<T>(
	agentDir: string,
	callback: () => Promise<T> | T,
): Promise<T> {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		return await callback();
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
}

function emitPermissionPrompt(yolo: ReturnType<typeof setup>): void {
	yolo.events.emit("permissions:ui_prompt", {
		requestId: "request-1",
		source: "tool_call",
		surface: "bash",
		value: "echo hello",
	});
}

const permissionOptions = [
	"Yes",
	"Yes, for this session",
	"No",
	"No, provide reason",
];

test("YOLO is opt-in, persists per session, and never changes native config", async () => {
	const agentDir = tempDir("pi-yolo-");
	const nativeConfigPath = configPath(agentDir);
	const nativeConfig =
		'{"yoloMode":false,"permission":{"bash":{"*":"ask","rm *":"deny"}}}\n';
	mkdirSync(join(agentDir, "extensions", "pi-permission-system"), {
		recursive: true,
	});
	writeFileSync(nativeConfigPath, nativeConfig);

	try {
		await withAgentDir(agentDir, async () => {
			const parent = setup(agentDir, "parent-session");
			parent.handlers.get("session_start")!({}, parent.ctx);

			assert.equal(parent.status(), "YOLO: OFF");
			assert.equal(existsSync(statePath(agentDir, "parent-session")), false);

			await parent.command("on");
			assert.equal(parent.status(), "YOLO: ON");
			assert.equal(readFileSync(nativeConfigPath, "utf8"), nativeConfig);
			assert.equal(
				JSON.parse(readFileSync(statePath(agentDir, "parent-session"), "utf8"))
					.enabled,
				true,
			);
			assert.equal(parent.reloads(), 1);

			parent.handlers.get("session_compact")!({}, parent.ctx);
			assert.equal(parent.status(), "YOLO: ON");

			const reloaded = setup(agentDir, "parent-session");
			reloaded.handlers.get("session_start")!({}, reloaded.ctx);
			assert.equal(reloaded.status(), "YOLO: ON");

			const child = setup(agentDir, "child-session");
			child.handlers.get("session_start")!({}, child.ctx);
			assert.equal(child.status(), "YOLO: OFF");
			assert.equal(readFileSync(nativeConfigPath, "utf8"), nativeConfig);
		});
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("YOLO leaves Home Manager-style JSONC config and denials untouched", async () => {
	const agentDir = tempDir("pi-yolo-jsonc-");
	const nativeConfigPath = configPath(agentDir);
	const nativeConfig = `{
  // Managed by Home Manager.
  "yoloMode": false,
  "permission": { "bash": { "*": "ask", "rm *": "deny" } }
}\n`;
	mkdirSync(join(agentDir, "extensions", "pi-permission-system"), {
		recursive: true,
	});
	writeFileSync(nativeConfigPath, nativeConfig);

	try {
		await withAgentDir(agentDir, async () => {
			const yolo = setup(agentDir, "jsonc-session");
			yolo.handlers.get("session_start")!({}, yolo.ctx);
			await yolo.command("on");

			assert.equal(readFileSync(nativeConfigPath, "utf8"), nativeConfig);
		});
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("YOLO auto-approves permission prompts through the public UI event", async () => {
	const agentDir = tempDir("pi-yolo-prompt-");

	try {
		await withAgentDir(agentDir, async () => {
			const yolo = setup(agentDir, "prompt-session");
			yolo.handlers.get("session_start")!({}, yolo.ctx);
			await yolo.command("on");

			emitPermissionPrompt(yolo);
			const selected = await yolo.ctx.ui.select(
				"Permission Required",
				permissionOptions,
			);
			assert.equal(selected, "Yes");
			assert.equal(yolo.selectCalls(), 0);

			emitPermissionPrompt(yolo);
			const decision = await yolo.ctx.ui.custom(
				() => {
					throw new Error("the native permission dialog should be bypassed");
				},
				{ overlay: false },
			);
			assert.deepEqual(decision, {
				approved: true,
				state: "approved",
				autoApproved: true,
			});
			assert.equal(yolo.customCalls(), 0);
		});
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("state revocation disables the overlay before the next prompt or tool", async () => {
	const agentDir = tempDir("pi-yolo-revoked-");

	try {
		await withAgentDir(agentDir, async () => {
			const yolo = setup(agentDir, "revoked-session");
			yolo.handlers.get("session_start")!({}, yolo.ctx);
			await yolo.command("on");
			rmSync(statePath(agentDir, "revoked-session"));

			emitPermissionPrompt(yolo);
			assert.deepEqual(await yolo.ctx.ui.custom(() => undefined), {
				original: true,
			});
			assert.equal(yolo.customCalls(), 1);
			assert.equal(yolo.status(), "YOLO: ERROR");
			assert.deepEqual(yolo.handlers.get("tool_call")!({}, yolo.ctx), {
				block: true,
				terminate: true,
				reason:
					"YOLO cannot verify a safe permission state; resolve YOLO: ERROR first.",
			});
		});
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("a permission decision clears a stale prompt arm", async () => {
	const agentDir = tempDir("pi-yolo-decision-");

	try {
		await withAgentDir(agentDir, async () => {
			const yolo = setup(agentDir, "decision-session");
			yolo.handlers.get("session_start")!({}, yolo.ctx);
			await yolo.command("on");

			emitPermissionPrompt(yolo);
			yolo.events.emit("permissions:decision", {
				requestId: "request-1",
				result: "deny",
			});
			assert.equal(
				await yolo.ctx.ui.select("Permission Required", permissionOptions),
				"No, provide reason",
			);
			assert.equal(yolo.selectCalls(), 1);
		});
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("YOLO restores exact UI methods during shutdown", async () => {
	const agentDir = tempDir("pi-yolo-shutdown-");

	try {
		await withAgentDir(agentDir, () => {
			const yolo = setup(agentDir, "shutdown-session");
			const originalSelect = yolo.ctx.ui.select;
			const originalCustom = yolo.ctx.ui.custom;
			yolo.handlers.get("session_start")!({}, yolo.ctx);
			assert.notEqual(yolo.ctx.ui.select, originalSelect);
			assert.notEqual(yolo.ctx.ui.custom, originalCustom);

			yolo.handlers.get("session_shutdown")!({}, yolo.ctx);
			assert.equal(yolo.ctx.ui.select, originalSelect);
			assert.equal(yolo.ctx.ui.custom, originalCustom);

			const reloaded = setup(agentDir, "shutdown-session");
			const reloadedSelect = reloaded.ctx.ui.select;
			const reloadedCustom = reloaded.ctx.ui.custom;
			reloaded.handlers.get("session_start")!({}, reloaded.ctx);
			reloaded.handlers.get("session_shutdown")!({}, reloaded.ctx);
			assert.equal(reloaded.ctx.ui.select, reloadedSelect);
			assert.equal(reloaded.ctx.ui.custom, reloadedCustom);
		});
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("YOLO leaves ordinary UI prompts untouched while disabled", async () => {
	const agentDir = tempDir("pi-yolo-ui-off-");

	try {
		await withAgentDir(agentDir, async () => {
			const yolo = setup(agentDir, "ui-off-session");
			yolo.handlers.get("session_start")!({}, yolo.ctx);

			emitPermissionPrompt(yolo);
			assert.equal(
				await yolo.ctx.ui.select("Permission Required", permissionOptions),
				"No, provide reason",
			);
			assert.equal(yolo.selectCalls(), 1);

			emitPermissionPrompt(yolo);
			assert.deepEqual(await yolo.ctx.ui.custom(() => undefined), {
				original: true,
			});
			assert.equal(yolo.customCalls(), 1);
		});
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("YOLO blocks tools before initial lifecycle synchronization", async () => {
	const agentDir = tempDir("pi-yolo-before-start-");

	try {
		await withAgentDir(agentDir, () => {
			const yolo = setup(agentDir, "before-start-session");
			assert.deepEqual(yolo.handlers.get("tool_call")!({}, yolo.ctx), {
				block: true,
				terminate: true,
				reason:
					"YOLO cannot verify a safe permission state; resolve YOLO: ERROR first.",
			});
			assert.equal(yolo.aborts(), 1);
		});
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("invalid state fails closed without claiming YOLO is off", async () => {
	const agentDir = tempDir("pi-yolo-invalid-state-");
	mkdirSync(join(agentDir, "yolo-state"), { recursive: true });
	writeFileSync(statePath(agentDir, "bad-session"), "{not-json}\n");

	try {
		await withAgentDir(agentDir, () => {
			const yolo = setup(agentDir, "bad-session");
			yolo.handlers.get("session_start")!({}, yolo.ctx);
			for (const text of [
				"run a tool",
				"/yolox",
				"/YOLO",
				"/yolo\tpayload",
				"/yolo\npayload",
			]) {
				assert.deepEqual(yolo.handlers.get("input")!({ text }, yolo.ctx), {
					action: "handled",
				});
			}
			assert.equal(
				yolo.handlers.get("input")!({ text: "/yolo off" }, yolo.ctx),
				undefined,
			);
			yolo.handlers.get("before_agent_start")!({}, yolo.ctx);
			yolo.handlers.get("agent_start")!({}, yolo.ctx);
			yolo.handlers.get("turn_start")!({}, yolo.ctx);
			assert.equal(yolo.status(), "YOLO: ERROR");
			assert.equal(yolo.aborts(), 3);
			assert.deepEqual(yolo.handlers.get("tool_call")!({}, yolo.ctx), {
				block: true,
				terminate: true,
				reason:
					"YOLO cannot verify a safe permission state; resolve YOLO: ERROR first.",
			});
			assert.match(yolo.notifications[0] ?? "", /invalid/i);
		});
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("YOLO can persist state without a permission-system config file", async () => {
	const agentDir = tempDir("pi-yolo-no-config-");

	try {
		await withAgentDir(agentDir, async () => {
			const yolo = setup(agentDir, "no-config-session");
			yolo.handlers.get("session_start")!({}, yolo.ctx);
			await yolo.command("on");
			assert.equal(yolo.status(), "YOLO: ON");
			assert.equal(existsSync(configPath(agentDir)), false);
		});
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("a reload failure does not lose a committed toggle", async () => {
	const agentDir = tempDir("pi-yolo-reload-failure-");

	try {
		await withAgentDir(agentDir, async () => {
			const yolo = setup(agentDir, "reload-failure-session", async () => {
				throw new Error("reload unavailable");
			});
			yolo.handlers.get("session_start")!({}, yolo.ctx);
			await yolo.command("on");

			assert.equal(
				JSON.parse(
					readFileSync(statePath(agentDir, "reload-failure-session"), "utf8"),
				).enabled,
				true,
			);
			assert.equal(
				yolo.notifications.some((message) => /reload failed/i.test(message)),
				true,
			);
		});
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("invalid command arguments do not change the session", async () => {
	const agentDir = tempDir("pi-yolo-invalid-command-");

	try {
		await withAgentDir(agentDir, async () => {
			const yolo = setup(agentDir, "invalid-command-session");
			yolo.handlers.get("session_start")!({}, yolo.ctx);
			await yolo.command("maybe");
			assert.equal(yolo.status(), "YOLO: OFF");
			assert.equal(yolo.reloads(), 0);
			assert.deepEqual(yolo.notifications, ["Usage: /yolo [on|off]"]);
		});
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});
