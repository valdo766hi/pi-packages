// Fast mode — opt into OpenAI's `priority` service tier for the current session.
//
// State lives in memory by default. Set PI_FAST=1 before starting Pi to opt
// the process into fast mode explicitly.

import type * as Pi from "@earendil-works/pi-coding-agent";
import { calculateCost } from "@earendil-works/pi-ai";

/** Providers whose requests fast mode may touch. Keeps OpenAI-compatible third parties out. */
const FAST_PROVIDERS = new Set(["openai", "openai-codex"]);

/** Request APIs that serialize a `service_tier` field. */
const FAST_APIS = new Set(["openai-responses", "openai-codex-responses"]);
const isEnvEnabled = () => process.env.PI_FAST === "1";

/**
 * Nerd-font bolt (nf-fa-bolt). Written as an escape because the literal glyph
 * lives in a private-use area and does not survive every editor and pipeline.
 */
const ICON = "\u{f0e7}";

export default function (pi: Pi.ExtensionAPI) {
	let enabled = isEnvEnabled();
	let pendingModel: Pi.ExtensionContext["model"];

	const updateStatus = (ctx: Pi.ExtensionContext) => {
		ctx.ui.setStatus("fast", `${ICON} FAST: ${enabled ? "ON" : "OFF"}`);
	};

	// Fast mode is not persisted by Pi; sessions start off unless PI_FAST=1.
	pi.on(
		"session_start",
		(_event: Pi.SessionStartEvent, ctx: Pi.ExtensionContext) => {
			enabled = isEnvEnabled();
			pendingModel = undefined;
			updateStatus(ctx);
		},
	);

	pi.on(
		"before_provider_request",
		(event: Pi.BeforeProviderRequestEvent, ctx: Pi.ExtensionContext) => {
			pendingModel = undefined;
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

			// Codex may report either default or priority; normalize its cost once.
			if (model.provider === "openai-codex") pendingModel = model;
			return { ...payload, service_tier: "priority" };
		},
	);

	pi.on("message_end", (event: Pi.MessageEndEvent) => {
		if (event.message.role !== "assistant" || !pendingModel) return;

		const model = pendingModel;
		if (event.message.provider !== model.provider || event.message.model !== model.id) return;
		pendingModel = undefined;
		const multiplier = model.id === "gpt-5.5" ? 2.5 : 2;
		const usage = { ...event.message.usage, cost: { ...event.message.usage.cost } };
		// Recalculate from catalog prices, not an already tier-adjusted response.
		const cost = calculateCost(model, usage);
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
