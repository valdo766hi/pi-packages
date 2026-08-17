# Pi fast mode extension

Install it with:

```sh
pi install npm:@valdo766hi/pi-fast
```

This extension registers `/fast`, which opts the current session into OpenAI's
`priority` service tier.

## Commands

```text
/fast       # toggle
/fast on    # enable
/fast off   # disable
```

State is in-memory by default. Every new or resumed session starts off, so a
session never inherits a paid tier from an earlier one. To explicitly opt a
process or spawned Pi session in, start it with `PI_FAST=1`; otherwise enable
`/fast on` separately in that session. The footer shows a nerd-font bolt
(`nf-fa-bolt`, U+F0E7) followed by `FAST: ON` or `FAST: OFF`.

The glyph is a private-use codepoint, so `fast.ts` writes it as the escape
`"\u{f0e7}"` rather than a literal — editors and pipelines have silently
replaced the literal with a space. `fast.test.ts` pins the codepoint.

## Provider behavior

While fast mode is on, the `before_provider_request` hook adds
`"service_tier": "priority"` to the request payload, but only when all of the
following hold:

- the active model's provider is `openai` or `openai-codex`
- the active model's api is `openai-responses` or `openai-codex-responses`,
  the two apis that serialize a `service_tier` field
- the payload is a plain object that does not already carry `service_tier`

Everything else — other providers, OpenAI-compatible third parties such as
`groq` or `openrouter`, Azure, and any explicitly set tier — is left unchanged.
For Codex, the extension also applies Pi's priority multiplier to reported costs,
because Codex reports the response tier as `default`.

## Tests

```sh
node --test packages/fast/fast.test.ts
```

The same test runs in the repository's Node.js and devenv checks.
