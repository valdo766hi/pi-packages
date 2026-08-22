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

function legacyConfigPath(agentDir: string): string {
	return join(agentDir, "pi-permissions.jsonc");
}

function permissionSystemPackageDir(agentDir: string): string {
	return join(
		agentDir,
		"npm",
		"node_modules",
		"@gotgenes",
		"pi-permission-system",
	);
}

function writePermissionSystemVersion(agentDir: string, version: string): void {
	const packageDir = permissionSystemPackageDir(agentDir);
	mkdirSync(packageDir, { recursive: true });
	writeFileSync(
		join(packageDir, "package.json"),
		JSON.stringify({ name: "@gotgenes/pi-permission-system", version }) + "\n",
	);
}

function statePath(agentDir: string, sessionId: string): string {
	return join(agentDir, "yolo-state", `${encodeURIComponent(sessionId)}.json`);
}

function readConfig(path: string): Record<string, any> {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		assert.fail(`Could not parse test config ${path}: ${String(error)}`);
	}
}

function setup(
	agentDir: string,
	sessionId: string,
	reload?: () => Promise<void>,
) {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const commands = new Map<string, any>();
	const notifications: string[] = [];
	let status = "";
	let reloads = 0;
	let aborts = 0;

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
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerCommand: (name: string, command: any) =>
			commands.set(name, command),
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
		handlers,
		command: (args = "") => commands.get("yolo")!.handler(args, ctx),
		notifications,
		reloads: () => reloads,
		aborts: () => aborts,
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

test("YOLO is opt-in and persists per session through reload and compaction", async () => {
	const agentDir = tempDir("pi-yolo-");
	const nativeConfigPath = configPath(agentDir);
	mkdirSync(join(agentDir, "extensions", "pi-permission-system"), {
		recursive: true,
	});
	writeFileSync(
		nativeConfigPath,
		JSON.stringify({
			yoloMode: true,
			permission: { bash: { "*": "ask", "rm *": "deny" } },
		}) + "\n",
	);

	try {
		await withAgentDir(agentDir, async () => {
			const parent = setup(agentDir, "parent-session");
			parent.handlers.get("session_start")!({}, parent.ctx);

			assert.equal(readConfig(nativeConfigPath).yoloMode, false);
			assert.equal(parent.status(), "YOLO: OFF");
			assert.equal(
				readConfig(nativeConfigPath).permission.bash["rm *"],
				"deny",
			);
			assert.equal(existsSync(statePath(agentDir, "parent-session")), false);

			await parent.command("on");
			assert.equal(readConfig(nativeConfigPath).yoloMode, true);
			assert.equal(
				JSON.parse(readFileSync(statePath(agentDir, "parent-session"), "utf8"))
					.enabled,
				true,
			);
			assert.equal(parent.reloads(), 1);

			// A native config rewrite cannot erase the session's explicit state.
			const rewritten = readConfig(nativeConfigPath);
			rewritten.yoloMode = false;
			writeFileSync(nativeConfigPath, `${JSON.stringify(rewritten)}\n`);
			parent.handlers.get("session_compact")!({}, parent.ctx);
			assert.equal(readConfig(nativeConfigPath).yoloMode, true);
			assert.equal(parent.status(), "YOLO: ON");

			// A reloaded extension instance restores the same session's state.
			const reloaded = setup(agentDir, "parent-session");
			reloaded.handlers.get("session_start")!({}, reloaded.ctx);
			assert.equal(reloaded.status(), "YOLO: ON");

			// A different session has no implicit opt-in, like packages/fast.
			const child = setup(agentDir, "child-session");
			child.handlers.get("session_start")!({}, child.ctx);
			assert.equal(child.status(), "YOLO: OFF");
			assert.equal(readConfig(nativeConfigPath).yoloMode, false);
		});
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("YOLO accepts native JSONC and preserves explicit deny rules", async () => {
	const agentDir = tempDir("pi-yolo-jsonc-");
	const nativeConfigPath = configPath(agentDir);
	writePermissionSystemVersion(agentDir, "25.3.0");
	mkdirSync(join(agentDir, "extensions", "pi-permission-system"), {
		recursive: true,
	});
	writeFileSync(
		nativeConfigPath,
		`{
  // Native permission-system config supports comments.
  "yoloMode": false,
  "promptMaxRows": 24,
  "promptFieldMaxWidth": 400,
  "permission": { "bash": { "*": "ask", "rm *": "deny" } }
}\n`,
	);

	try {
		await withAgentDir(agentDir, async () => {
			const yolo = setup(agentDir, "jsonc-session");
			yolo.handlers.get("session_start")!({}, yolo.ctx);
			await yolo.command("on");

			const native = readConfig(nativeConfigPath);
			assert.equal(native.yoloMode, true);
			assert.equal(native.promptMaxRows, 24);
			assert.equal(native.promptFieldMaxWidth, 400);
			assert.equal(native.permission.bash["rm *"], "deny");
		});
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("YOLO blocks tools before initial lifecycle synchronization", async () => {
	const agentDir = tempDir("pi-yolo-before-start-");
	const nativeConfigPath = configPath(agentDir);
	mkdirSync(join(agentDir, "extensions", "pi-permission-system"), {
		recursive: true,
	});
	writeFileSync(nativeConfigPath, '{"yoloMode":false}\n');

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

test("legacy global yolo config is overridden off until this session opts in", async () => {
	const agentDir = tempDir("pi-yolo-legacy-global-");
	const nativeConfigPath = configPath(agentDir);
	writeFileSync(legacyConfigPath(agentDir), '{"yoloMode":true}\n');

	try {
		await withAgentDir(agentDir, async () => {
			const yolo = setup(agentDir, "legacy-session");
			yolo.handlers.get("session_start")!({}, yolo.ctx);

			assert.equal(readConfig(nativeConfigPath).yoloMode, false);
			assert.equal(yolo.status(), "YOLO: OFF");
			await yolo.command("on");
			assert.equal(readConfig(nativeConfigPath).yoloMode, true);
			assert.equal(readConfig(legacyConfigPath(agentDir)).yoloMode, true);
		});
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("legacy extension config is overridden off until this session opts in", async () => {
	const agentDir = tempDir("pi-yolo-legacy-extension-");
	const nativeConfigPath = configPath(agentDir);
	writePermissionSystemVersion(agentDir, "25.3.0");
	writeFileSync(
		join(permissionSystemPackageDir(agentDir), "config.json"),
		'{"yoloMode":true}\n',
	);

	try {
		await withAgentDir(agentDir, async () => {
			const yolo = setup(agentDir, "legacy-extension-session");
			yolo.handlers.get("session_start")!({}, yolo.ctx);

			assert.equal(readConfig(nativeConfigPath).yoloMode, false);
			assert.equal(yolo.status(), "YOLO: OFF");
			await yolo.command("on");
			assert.equal(readConfig(nativeConfigPath).yoloMode, true);
		});
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("invalid native schema fails closed instead of claiming YOLO is off", async () => {
	const agentDir = tempDir("pi-yolo-invalid-schema-");
	const nativeConfigPath = configPath(agentDir);
	mkdirSync(join(agentDir, "extensions", "pi-permission-system"), {
		recursive: true,
	});
	writeFileSync(legacyConfigPath(agentDir), '{"yoloMode":true}\n');
	writeFileSync(nativeConfigPath, '{"yoloMode":false,"unknownSetting":true}\n');

	try {
		await withAgentDir(agentDir, () => {
			const yolo = setup(agentDir, "invalid-schema-session");
			yolo.handlers.get("session_start")!({}, yolo.ctx);

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

test("new prompt bounds are rejected by older permission-system versions", async () => {
	for (const field of ["promptMaxRows", "promptFieldMaxWidth"]) {
		const agentDir = tempDir(`pi-yolo-old-prompt-${field}-`);
		const nativeConfigPath = configPath(agentDir);
		writePermissionSystemVersion(agentDir, "25.2.0");
		mkdirSync(join(agentDir, "extensions", "pi-permission-system"), {
			recursive: true,
		});
		writeFileSync(
			nativeConfigPath,
			JSON.stringify({ yoloMode: false, [field]: 24 }) + "\n",
		);

		try {
			await withAgentDir(agentDir, () => {
				const yolo = setup(agentDir, `old-prompt-${field}`);
				yolo.handlers.get("session_start")!({}, yolo.ctx);
				assert.equal(yolo.status(), "YOLO: ERROR", field);
			});
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	}
});

test("new prompt bounds require positive safe integers", async () => {
	const invalidValues: unknown[] = [0, 1.5, Number.MAX_SAFE_INTEGER + 1, "24"];
	for (const field of ["promptMaxRows", "promptFieldMaxWidth"]) {
		for (const value of invalidValues) {
			const agentDir = tempDir(`pi-yolo-prompt-${field}-`);
			const nativeConfigPath = configPath(agentDir);
			writePermissionSystemVersion(agentDir, "25.3.0");
			mkdirSync(join(agentDir, "extensions", "pi-permission-system"), {
				recursive: true,
			});
			writeFileSync(
				nativeConfigPath,
				JSON.stringify({ yoloMode: false, [field]: value }) + "\n",
			);

			try {
				await withAgentDir(agentDir, () => {
					const yolo = setup(agentDir, `bad-prompt-${field}`);
					yolo.handlers.get("session_start")!({}, yolo.ctx);
					assert.equal(
						yolo.status(),
						"YOLO: ERROR",
						`${field}=${String(value)}`,
					);
				});
			} finally {
				rmSync(agentDir, { recursive: true, force: true });
			}
		}
	}
});

test("unsafe native numeric values fail closed instead of shadowing legacy YOLO", async () => {
	const agentDir = tempDir("pi-yolo-unsafe-number-");
	const nativeConfigPath = configPath(agentDir);
	writePermissionSystemVersion(agentDir, "25.3.0");
	mkdirSync(join(agentDir, "extensions", "pi-permission-system"), {
		recursive: true,
	});
	writeFileSync(legacyConfigPath(agentDir), '{"yoloMode":true}\n');
	writeFileSync(
		nativeConfigPath,
		'{"yoloMode":false,"forwardingTimeoutMs":9007199254740992,"promptMaxRows":9007199254740992,"promptFieldMaxWidth":9007199254740992}\n',
	);

	try {
		await withAgentDir(agentDir, () => {
			const yolo = setup(agentDir, "unsafe-number-session");
			yolo.handlers.get("session_start")!({}, yolo.ctx);

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

test("missing project trust information fails closed", async () => {
	const agentDir = tempDir("pi-yolo-missing-trust-");
	const nativeConfigPath = configPath(agentDir);
	mkdirSync(join(agentDir, "extensions", "pi-permission-system"), {
		recursive: true,
	});
	writeFileSync(nativeConfigPath, '{"yoloMode":false}\n');

	try {
		await withAgentDir(agentDir, () => {
			const yolo = setup(agentDir, "missing-trust-session");
			Reflect.deleteProperty(yolo.ctx as object, "isProjectTrusted");
			yolo.handlers.get("session_start")!({}, yolo.ctx);

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

test("invalid state fails closed without claiming YOLO is off", async () => {
	const agentDir = tempDir("pi-yolo-invalid-state-");
	const nativeConfigPath = configPath(agentDir);
	mkdirSync(join(agentDir, "extensions", "pi-permission-system"), {
		recursive: true,
	});
	writeFileSync(nativeConfigPath, '{"yoloMode":true}\n');
	mkdirSync(join(agentDir, "yolo-state"), { recursive: true });
	writeFileSync(statePath(agentDir, "bad-session"), "{not-json}\n");

	try {
		await withAgentDir(agentDir, () => {
			const yolo = setup(agentDir, "bad-session");
			yolo.handlers.get("session_start")!({}, yolo.ctx);
			assert.deepEqual(
				yolo.handlers.get("input")!({ text: "run a tool" }, yolo.ctx),
				{ action: "handled" },
			);
			for (const text of [
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
			assert.equal(readConfig(nativeConfigPath).yoloMode, false);
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

test("a trusted project override cannot silently enable YOLO", async () => {
	const agentDir = tempDir("pi-yolo-project-override-");
	const nativeConfigPath = configPath(agentDir);
	const projectConfigPath = join(
		agentDir,
		".pi",
		"extensions",
		"pi-permission-system",
		"config.json",
	);
	mkdirSync(join(agentDir, "extensions", "pi-permission-system"), {
		recursive: true,
	});
	mkdirSync(join(agentDir, ".pi", "extensions", "pi-permission-system"), {
		recursive: true,
	});
	writeFileSync(nativeConfigPath, '{"yoloMode":false}\n');
	writeFileSync(projectConfigPath, '{"yoloMode":true}\n');

	try {
		await withAgentDir(agentDir, async () => {
			const yolo = setup(agentDir, "project-override-session");
			yolo.handlers.get("session_start")!({}, yolo.ctx);
			yolo.handlers.get("before_agent_start")!({}, yolo.ctx);

			assert.equal(yolo.status(), "YOLO: ERROR");
			assert.equal(yolo.aborts(), 1);
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

test("missing native config keeps the default off but rejects enabling", async () => {
	const agentDir = tempDir("pi-yolo-missing-config-");
	mkdirSync(agentDir, { recursive: true });

	try {
		await withAgentDir(agentDir, async () => {
			const yolo = setup(agentDir, "missing-config-session");
			yolo.handlers.get("session_start")!({}, yolo.ctx);
			assert.equal(yolo.status(), "YOLO: OFF");
			await yolo.command("on");
			assert.equal(yolo.reloads(), 0);
			assert.equal(
				yolo.notifications.some((message) => /missing/i.test(message)),
				true,
			);
		});
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("a reload failure does not lose a committed toggle", async () => {
	const agentDir = tempDir("pi-yolo-reload-failure-");
	const nativeConfigPath = configPath(agentDir);
	mkdirSync(join(agentDir, "extensions", "pi-permission-system"), {
		recursive: true,
	});
	writeFileSync(nativeConfigPath, '{"yoloMode":false}\n');

	try {
		await withAgentDir(agentDir, async () => {
			const yolo = setup(agentDir, "reload-failure-session", async () => {
				throw new Error("reload unavailable");
			});
			yolo.handlers.get("session_start")!({}, yolo.ctx);
			await yolo.command("on");

			assert.equal(readConfig(nativeConfigPath).yoloMode, true);
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
	const nativeConfigPath = configPath(agentDir);
	mkdirSync(join(agentDir, "extensions", "pi-permission-system"), {
		recursive: true,
	});
	writeFileSync(nativeConfigPath, '{"yoloMode":false}\n');

	try {
		await withAgentDir(agentDir, async () => {
			const yolo = setup(agentDir, "invalid-command-session");
			yolo.handlers.get("session_start")!({}, yolo.ctx);
			await yolo.command("maybe");
			assert.equal(readConfig(nativeConfigPath).yoloMode, false);
			assert.equal(yolo.reloads(), 0);
			assert.deepEqual(yolo.notifications, ["Usage: /yolo [on|off]"]);
		});
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});
