// Drives fast.ts through a minimal stand-in for pi's extension API.
// Run with: node --test fast.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
	name: "Test Codex",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
	contextWindow: 100_000,
	maxTokens: 1000,
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
		finishMessage: (message: unknown) => handlers.get("message_end")!({ type: "message_end", message }, ctx),
		message: (cost: number) =>
			handlers.get("message_end")!(
				{
					type: "message_end",
					message: {
						role: "assistant",
						provider: ctx.model?.provider,
						model: ctx.model?.id,
						usage: {
							input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000,
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

test("an already priority-priced Codex message is not multiplied again", async () => {
	const pi = setup();
	await pi.fast("on");
	pi.request({ model: CODEX.id }, CODEX);
	assert.equal(pi.message(2)?.message.usage.cost.total, 8);
});

test("unrelated message endings do not consume Codex pricing state", async () => {
	const pi = setup();
	await pi.fast("on");
	pi.request({}, CODEX);
	assert.equal(pi.finishMessage({ role: "assistant", provider: "other", model: "other" }), undefined);
	assert.equal(pi.message(1)?.message.usage.cost.total, 8);
	assert.equal(pi.message(2), undefined, "a matching request is adjusted only once");
});

test("native Codex SSE pricing is normalized once for default and priority responses", async () => {
	const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));
	const { stream } = await import(pathToFileURL(join(dirname(entry), "api/openai-codex-responses.js")).href);
	const apiKey = `stub.${Buffer.from(JSON.stringify({
		"https://api.openai.com/auth": { chatgpt_account_id: "test-only" },
	})).toString("base64")}.stub`;
	for (const id of [CODEX.id, "gpt-5.5"]) {
		for (const tier of ["default", "priority"]) {
			const pi = setup();
			await pi.fast("on");
			const model = { ...CODEX, id };
			const event = {
				type: "response.completed",
				response: {
					id: "test", status: "completed", service_tier: tier, output: [],
					usage: { input_tokens: 1_000_000, output_tokens: 0, total_tokens: 1_000_000 },
				},
			};
			const message = await stream(model, { messages: [] }, {
				apiKey, transport: "sse",
				fetch: async () => new Response(`data: ${JSON.stringify(event)}\n\n`),
				onPayload: (payload: unknown) => pi.request(payload, model),
			}).result();
			assert.notEqual(message.stopReason, "error", message.errorMessage);
			const nativeCost = message.usage.cost.total;
			const result = pi.finishMessage(message)?.message;
			assert.equal(result.usage.cost.total, id === "gpt-5.5" ? 2.5 : 2);
			assert.equal(message.usage.cost.total, nativeCost, "the original message is unchanged");
		}
	}
});
