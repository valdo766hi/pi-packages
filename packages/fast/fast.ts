// Fast mode — opt into OpenAI's `priority` service tier for the current session.
//
// State lives in memory only: every new pi session starts with fast mode off.

import type * as Pi from "@earendil-works/pi-coding-agent";

/** Providers whose requests fast mode may touch. Keeps OpenAI-compatible third parties out. */
const FAST_PROVIDERS = new Set(["openai", "openai-codex"]);

/** Request APIs that serialize a `service_tier` field. */
const FAST_APIS = new Set(["openai-responses", "openai-codex-responses"]);

/**
 * Nerd-font bolt (nf-fa-bolt). Written as an escape because the literal glyph
 * lives in a private-use area and does not survive every editor and pipeline.
 */
const ICON = "\u{f0e7}";

export default function (pi: Pi.ExtensionAPI) {
	let enabled = false;
	let pendingCostMultiplier = 1;

	const updateStatus = (ctx: Pi.ExtensionContext) => {
		ctx.ui.setStatus("fast", `${ICON} FAST: ${enabled ? "ON" : "OFF"}`);
	};

	// Fast mode is never persisted; a new or resumed session always starts off.
	pi.on(
		"session_start",
		(_event: Pi.SessionStartEvent, ctx: Pi.ExtensionContext) => {
			enabled = false;
			pendingCostMultiplier = 1;
			updateStatus(ctx);
		},
	);

	pi.on(
		"before_provider_request",
		(event: Pi.BeforeProviderRequestEvent, ctx: Pi.ExtensionContext) => {
			pendingCostMultiplier = 1;
			if (!enabled) return;

			const model = ctx.model;
			if (
				!model ||
				!FAST_PROVIDERS.has(model.provider) ||
				!FAST_APIS.has(model.api)
			)
				return;

			const payload = event.payload;
			if (
				payload === null ||
				typeof payload !== "object" ||
				Array.isArray(payload)
			)
				return;

			// An explicit tier — including one set by an earlier handler — wins.
			if ("service_tier" in payload) return;

			// Codex reports its tier as "default", so Pi cannot price a tier added this late.
			if (model.provider === "openai-codex") {
				pendingCostMultiplier = model.id === "gpt-5.5" ? 2.5 : 2;
			}
			return { ...payload, service_tier: "priority" };
		},
	);

	pi.on("message_end", (event: Pi.MessageEndEvent) => {
		if (event.message.role !== "assistant" || pendingCostMultiplier === 1)
			return;

		const multiplier = pendingCostMultiplier;
		pendingCostMultiplier = 1;
		const cost = event.message.usage.cost;
		return {
			message: {
				...event.message,
				usage: {
					...event.message.usage,
					cost: {
						input: cost.input * multiplier,
						output: cost.output * multiplier,
						cacheRead: cost.cacheRead * multiplier,
						cacheWrite: cost.cacheWrite * multiplier,
						total: cost.total * multiplier,
					},
				},
			},
		};
	});

	pi.registerCommand("fast", {
		description: "Toggle OpenAI priority service tier for this session",
		handler: async (args: string, ctx: Pi.ExtensionCommandContext) => {
			const requested = args.trim().toLowerCase();
			if (requested && requested !== "on" && requested !== "off") {
				ctx.ui.notify("Usage: /fast [on|off]", "warning");
				return;
			}

			enabled = requested ? requested === "on" : !enabled;
			updateStatus(ctx);
			ctx.ui.notify(`Fast mode: ${enabled ? "on" : "off"}`, "info");
		},
	});
}
