// Drives fast.ts through a minimal stand-in for pi's extension API.
// Run with: node --test fast.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import fastExtension from "./fast.ts";

const OPENAI = {
	id: "gpt-5.6-sol",
	provider: "openai",
	api: "openai-responses",
};
const CODEX = {
	id: "gpt-5.6-sol",
	provider: "openai-codex",
	api: "openai-codex-responses",
};

function setup(options: { fastFromEnv?: boolean } = {}) {
	const previousFastEnv = process.env.PI_FAST;
	if (options.fastFromEnv) process.env.PI_FAST = "1";
	else delete process.env.PI_FAST;

	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const commands = new Map<
		string,
		{ handler: (args: string, ctx: any) => Promise<void> }
	>();
	const notifications: string[] = [];
	const statuses = new Map<string, string>();

	const ctx = {
		model: undefined as
			| { id?: string; provider: string; api: string }
			| undefined,
		ui: {
			setStatus: (key: string, text: string) => statuses.set(key, text),
			notify: (message: string) => notifications.push(message),
		},
	};

	const pi = {
		on: (event: string, handler: (event: any, ctx: any) => any) =>
			handlers.set(event, handler),
		registerCommand: (name: string, command: any) =>
			commands.set(name, command),
	};

	try {
		fastExtension(pi as any);
		handlers.get("session_start")!({ type: "session_start" }, ctx);
	} finally {
		if (previousFastEnv === undefined) delete process.env.PI_FAST;
		else process.env.PI_FAST = previousFastEnv;
	}

	return {
		notifications,
		/** Reported state, read back from the status pi renders. */
		state: () => (statuses.get("fast") === "\u{f0e7} FAST: ON" ? "on" : "off"),
		status: () => statuses.get("fast"),
		fast: (args = "") => commands.get("fast")!.handler(args, ctx),
		request: (
			payload: unknown,
			model?: { id?: string; provider: string; api: string },
		) => {
			ctx.model = model;
			return handlers.get("before_provider_request")!(
				{ type: "before_provider_request", payload },
				ctx,
			);
		},
		message: (cost: number) =>
			handlers.get("message_end")!(
				{
					type: "message_end",
					message: {
						role: "assistant",
						usage: {
							cost: {
								input: cost,
								output: cost,
								cacheRead: cost,
								cacheWrite: cost,
								total: cost * 4,
							},
						},
					},
				},
				ctx,
			),
	};
}

test("a new session starts off, even after a parent enables fast mode", async () => {
	const parent = setup();
	await parent.fast("on");
	assert.equal(parent.state(), "on");

	// A spawned subagent has its own extension instance and session state.
	const child = setup();
	assert.equal(child.state(), "off");
});

test("PI_FAST=1 explicitly enables fast mode for a new process", () => {
	assert.equal(setup({ fastFromEnv: true }).state(), "on");
});

// The bolt is a private-use codepoint, so pin it: tooling has silently
// replaced it with a plain space before.
test("the status carries the nerd-font bolt", async () => {
	const pi = setup();
	assert.equal(pi.status(), "\u{f0e7} FAST: OFF");
	await pi.fast("on");
	assert.equal(pi.status(), "\u{f0e7} FAST: ON");
});

test("/fast toggles, /fast on|off sets", async () => {
	const pi = setup();

	await pi.fast();
	assert.equal(pi.state(), "on");
	await pi.fast();
	assert.equal(pi.state(), "off");

	await pi.fast("on");
	assert.equal(pi.state(), "on");
	await pi.fast("on");
	assert.equal(pi.state(), "on");

	await pi.fast("off");
	assert.equal(pi.state(), "off");
	await pi.fast("off");
	assert.equal(pi.state(), "off");

	assert.deepEqual(pi.notifications, [
		"Fast mode: on",
		"Fast mode: off",
		"Fast mode: on",
		"Fast mode: on",
		"Fast mode: off",
		"Fast mode: off",
	]);
});

test("an invalid argument is rejected without changing state", async () => {
	const pi = setup();
	await pi.fast("maybe");
	assert.equal(pi.state(), "off");
	assert.deepEqual(pi.notifications, ["Usage: /fast [on|off]"]);
});

test("fast off leaves every request untouched", async () => {
	const pi = setup();
	assert.equal(pi.request({ model: "gpt-5.6-sol" }, CODEX), undefined);
	assert.equal(pi.request({ model: "gpt-5.6-sol" }, OPENAI), undefined);
});

test("fast on injects the priority tier for openai and codex", async () => {
	const pi = setup();
	await pi.fast("on");

	for (const model of [OPENAI, CODEX]) {
		assert.deepEqual(
			pi.request({ model: "gpt-5.6-sol", stream: true }, model),
			{
				model: "gpt-5.6-sol",
				stream: true,
				service_tier: "priority",
			},
		);
	}
});

test("fast on leaves unsupported providers and apis alone", async () => {
	const pi = setup();
	await pi.fast("on");

	const untouched = [
		{ provider: "anthropic", api: "anthropic-messages" },
		{ provider: "google", api: "google-generative-ai" },
		// OpenAI-compatible third parties: right api, wrong provider.
		{ provider: "groq", api: "openai-completions" },
		{ provider: "openrouter", api: "openai-responses" },
		// Azure serializes its own tiers.
		{ provider: "azure-openai-responses", api: "azure-openai-responses" },
		// Right provider, api without a service_tier field.
		{ provider: "openai", api: "openai-completions" },
	];

	for (const model of untouched) {
		assert.equal(pi.request({ model: "m" }, model), undefined, model.provider);
	}
	assert.equal(pi.request({ model: "m" }, undefined), undefined);
});

test("Codex priority requests use priority cost accounting", async () => {
	const pi = setup();
	await pi.fast("on");

	pi.request({ model: CODEX.id }, CODEX);
	assert.deepEqual(pi.message(1)?.message.usage.cost, {
		input: 2,
		output: 2,
		cacheRead: 2,
		cacheWrite: 2,
		total: 8,
	});
	assert.equal(pi.message(1), undefined, "the multiplier is consumed once");

	pi.request({ model: "gpt-5.5" }, { ...CODEX, id: "gpt-5.5" });
	assert.equal(pi.message(1)?.message.usage.cost.total, 10);

	pi.request({ model: OPENAI.id }, OPENAI);
	assert.equal(
		pi.message(1),
		undefined,
		"OpenAI prices the response tier itself",
	);
});

test("fast on preserves an existing service_tier", async () => {
	const pi = setup();
	await pi.fast("on");

	assert.equal(
		pi.request({ model: "m", service_tier: "flex" }, CODEX),
		undefined,
	);
	assert.equal(
		pi.request({ model: "m", service_tier: undefined }, CODEX),
		undefined,
	);
});

test("fast on ignores payloads that are not plain objects", async () => {
	const pi = setup();
	await pi.fast("on");

	for (const payload of [null, undefined, "body", 42, [1, 2]]) {
		assert.equal(pi.request(payload, CODEX), undefined);
	}
});
