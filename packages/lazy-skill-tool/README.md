# `@valdo766hi/pi-lazy-skill-tool`

A Pi extension that keeps skill routing metadata compact and loads instructions only after an exact-name `skill` call.

Pi remains the source of truth for skill discovery, duplicate resolution, trust, package/settings paths, temporary CLI paths, and canonical file locations. This extension does not scan for skills independently.

## What v0.3.0 does

- Makes `adaptive` the default: start compact, keep every policy-visible skill discoverable, and expand when evidence is weak or the full catalog is inexpensive.
- Keeps `safe` as an override that always exposes complete descriptions for every policy-visible, model-invokable skill.
- Registers two model tools: exact-name `skill` and metadata-only `skill_search`.
- Puts per-task routing catalogs in a task-local custom message so the system prompt prefix stays stable.
- Publishes one complete generation (`ready`) or blocks skill operations (`blocked`); unsafe integration failures abort the provider request instead of replacing Pi's host prompt.
- Rechecks authorization after async approval or file reads, and binds paginated skill bodies to a source revision.

The router controls presentation, not authority, permissions, or the final skill choice. Hiding descriptions cannot guarantee identical selection to showing every description. Selection quality is demonstrated against the `safe` baseline; authorization and complete discovery are guaranteed.

“Lazy” describes model-context injection. Pi still reads skill frontmatter during canonical resource discovery.

## Install and compatibility

```sh
pi install npm:@valdo766hi/pi-lazy-skill-tool
```

The package requires:

- Node.js `>=22.19.0`;
- `@earendil-works/pi-coding-agent >=0.85.1 <0.86.0`;
- `typebox >=1.3.7 <2.0.0` supplied by Pi.

v0.3.0 uses Pi 0.85's canonical skill formatter, anchored skill-block parser, command registry, tool ownership metadata, active-tool API, project trust state, `before_agent_start` custom messages, `context` hooks, and composed autocomplete API. The verified minimum and current compatible release is `0.85.1`. Pi 0.85.0 exposes the needed type surface, but its published top-level module fails a clean import because it references an undeclared `@earendil-works/pi-server`; this package therefore does not claim 0.85.0 support. It does not claim compatibility outside the 0.85 minor series.

Pi catches errors from `before_agent_start`, `context`, and `before_provider_request` and continues. This package therefore does not rely on thrown hook errors. When safe context cannot be established it strips skill metadata from the host prompt, publishes `blocked`, and calls `ctx.abort()` from `context`, `agent_start`, `turn_start`, and `before_provider_request` — after the agent run exists, so the abort signal can cancel the provider request.

## Adaptive routing is the default

`adaptive` chooses how much metadata to expose. It never loads a skill because a score is high, and it never changes the selected model, provider, reasoning level, or credentials.

| Situation | Behavior |
| --- | --- |
| Complete catalog fits `catalogTokenBudget` | Show the full compact catalog. |
| Explicit `/lazy-skill:name` or `/skill:name` | Pin that canonical skill and bypass ranking. |
| Useful shortlist for a large catalog | Show complete candidate descriptions, remaining exact names, and discovery instructions. |
| Weak evidence, ambiguous cutoff, or retrieval error | Show the full policy-filtered catalog, even if it exceeds `catalogTokenBudget`. Compactness is only used when ranking is confident. |
| Full catalog exceeds the budget | Mark discovery incomplete and require `skill_search` pagination. Descriptions are never silently truncated. |
| Invalid policy, failed publication, or foreign `skill` tool | Block the affected operation. Do not fall back to unfiltered native loading. |

Adaptive occasionally behaves like `safe`. That is successful adaptation.

`safe` always exposes complete descriptions for every policy-visible, model-invokable skill. `full` remains a deprecated alias for `safe`.

Default configuration after validation:

```json
{
  "routing": "adaptive",
  "maxDescriptionCharacters": 0,
  "resourceFileSampleLimit": 0,
  "catalogTokenBudget": 4096
}
```

`catalogTokenBudget` is measured in Pi `estimateTokens()` units against the compact catalog. Zero means the full policy-visible catalog always fits. The default is 4096 so typical and medium catalogs keep every complete description, matching `safe`. Do not use a skill-count cutoff; description length matters more than count.

There are no embeddings, network calls, routing-model calls, filesystem watchers, or independent discovery caches. Ranking diagnostics stay in local custom-message `details`, not in model-facing text.

## Exact-name loading and metadata search

The model calls:

```json
{"name":"pdfs"}
```

The tool looks up that exact key in the current immutable skill snapshot and reads only Pi's canonical `filePath`. Model input never becomes a path.

A successful response has two model-facing text items:

1. frontmatter-stripped Markdown instructions;
2. compact JSON containing the canonical base directory and, only when needed, continuation or explicitly enabled resource metadata.

Complete result:

```json
{"base":"/canonical/skills/pdfs"}
```

Continuation:

```json
{"base":"/canonical/skills/pdfs","next":{"offset":121,"column":1,"rev":"a1b2c3d4e5f6a7b8"}}
```

The body is not wrapped in XML, JSON, CDATA, or a Markdown fence. The exact skill name, canonical path, source information, policy decision, and diagnostics remain in non-model tool details.

Offsets and columns are one-based and relative to the **frontmatter-stripped body**, not the original file. Each chunk uses Pi's 2,000-line/50-KiB read limits. A single oversized line is split at a UTF-8-safe character boundary and continued with the returned line, column, and source revision. Continuation without a matching `rev` fails with `SKILL_SOURCE_CHANGED` so page one and page two cannot come from different file versions.

At every load the extension:

- opens the canonical file asynchronously;
- bounds the initial read and rejects an oversized source before reading it in full, with a 16-MiB default ceiling;
- decodes UTF-8 fatally;
- reparses frontmatter;
- verifies the canonical name did not change;
- respects a newly added `disable-model-invocation: true` for model calls;
- rejects an empty body;
- reads no cached Markdown body.

Nearby resource sampling is disabled by default. When enabled, relative resource names are included only when the bounded sample is nonempty.

### `skill_search`

`skill` remains exact-name-only. Discover metadata with `skill_search` over the **entire policy-visible registry**, not the initial shortlist:

```ts
skill_search({ query: "investigate database connection exhaustion" })
skill_search({}) // browse all policy-visible skill metadata
skill_search({ cursor: previousResult.nextCursor })
```

Results include exact names and complete descriptions. They never include skill bodies or filesystem paths. Browse-all pagination is deterministic and independent of lexical matching. Cursors are bound to the current registry/policy fingerprint and query; stale cursors are rejected. “No strong search match” is not represented as “no relevant skill exists.”

Scores, ranking evidence, and canonical paths stay in non-model details.

Candidates are suggestions, not an exhaustive catalog. Search when they do not cover the task, when the task changes, or before concluding that no suitable skill exists. Search is not required before every action.

## Explicit commands

All three forms use Pi's canonical skill command registry and native expansion:

```text
/lazy-skill pdfs
/lazy-skill pdfs preserve  two  spaces
/lazy-skill:pdfs preserve  two  spaces
/skill:pdfs preserve  two  spaces
```

`/lazy-skill <name> [args]` forwards to `/skill:<name> [args]` with Pi prompt expansion enabled. During streaming it queues a `followUp`. The argument tail is not shell-parsed, unquoted, or reserialized; only the command/name separator is normalized. Pi's native parser terminates a skill name at the first literal space and may trim surrounding argument whitespace.

`/lazy-skill:<name>` is transformed to the native `/skill:<name>` form in Pi's `input` event. Native `/skill:<name>` passes through the same authorization boundary, so it cannot bypass policy. A later transformer that changes the approved canonical block is checked again before provider context.

With no argument, `/lazy-skill` opens a selector when dialog UI exists. The selector and dynamic completion show:

- exact name;
- complete description;
- Pi's canonical `scope/source` labels;
- `ask` when approval is required.

Denied skills are absent. In modes without dialog UI, no-argument invocation reports usage. Unknown names are handled as errors and are never sent as ordinary user prompts. Names containing a literal space are shown as unsupported because Pi's native slash grammar cannot represent them unambiguously.

A `disable-model-invocation` skill remains available through explicit commands, subject to external policy, but remains unavailable to model tool calls.

## Policy configuration

Configuration is loaded at `session_start`. Changes take effect after `/reload` or in a new session.

Locations, from lower to higher precedence:

1. built-in defaults;
2. `${getAgentDir()}/lazy-skill.json` (normally `~/.pi/agent/lazy-skill.json`);
3. `${cwd}/.pi/lazy-skill.json`, only when Pi reports the current project as trusted;
4. supported environment-variable overrides.

The extension uses Pi's current `cwd` directly. It does not walk parent directories or invent another project root.

Example using the immutable v0.3.0 schema URL:

```json
{
  "$schema": "https://raw.githubusercontent.com/valdo766hi/pi-packages/pi-lazy-skill-tool-0.3.0/packages/lazy-skill-tool/schema/lazy-skill.schema.json",
  "routing": "adaptive",
  "permission": {
    "skill": {
      "default": "allow",
      "rules": [
        { "pattern": "production-*", "action": "ask" },
        { "pattern": "private-*", "action": "deny" }
      ]
    }
  },
  "maxDescriptionCharacters": 0,
  "maxSourceBytes": 16777216,
  "resourceFileSampleLimit": 0,
  "catalogTokenBudget": 4096
}
```

A scalar is shorthand for a default with no rules:

```json
{"permission":{"skill":"ask"}}
```

### Permission semantics

Actions are exactly:

- `allow`: catalog-visible when model-invokable and loads without approval;
- `ask`: metadata may be discoverable, but body disclosure requires approval;
- `deny`: hidden from this extension's catalogs and search results, and blocked everywhere.

These semantics do not change with confidence, fallback, or token budget.

Patterns match exact skill names. Only `*` (zero or more characters) and `?` (one character) are wildcards; every regex metacharacter is treated literally. Rules run in declared order and the **last matching rule wins**. The default applies when no rule matches and defaults to `allow` for v0.1 compatibility.

Policy merging is explicit:

- the project default replaces the global default only when the project sets one;
- global rules come first;
- trusted-project rules are appended after global rules;
- environment overrides are applied last;
- rule arrays are never deep-merged by object-key behavior.

Malformed JSON, duplicate or unknown fields, invalid actions, malformed rules, and unreadable existing config files produce `POLICY_INVALID`. In that state the extension publishes no model catalog and blocks both model and explicit skill loading. Missing files use defaults. An invalid project file is ignored only when the project itself is untrusted and Pi therefore does not authorize loading it.

### Ask behavior

Interactive choices are:

```text
Allow once
Always allow this skill for this session
Reject
```

A session approval is keyed by exact name, canonical path, and policy fingerprint. It is cleared on session replacement and invalidated by a changed path or policy fingerprint. One invocation creates at most one prompt: the boundary handler issues a scoped ticket and the defense-in-depth execution/context check consumes it.

In `print`, `json`, or another noninteractive mode without approval UI, `ask` fails closed with `SKILL_APPROVAL_REQUIRED`. It is never silently treated as `allow`.

Policy is enforced at:

1. catalog visibility;
2. every resolved tool call named `skill`, even if another extension owns it;
3. this extension's own tool immediately before reading;
4. `/lazy-skill`, `/lazy-skill:`, and native `/skill:` input;
5. exact, whole-message Pi skill blocks immediately before provider context.

The final guard matches both canonical name and canonical path, rereads the current body, and binds one-time approval to a stable session entry ID when available (otherwise timestamp plus content fingerprint). Pasted or altered canonical-looking blocks cannot bypass `ask` or `deny`. Denial replaces the entire block with a concise code that contains no skill name, description, path, or body.

### Environment compatibility

| Variable | Default | Behavior |
| --- | --- | --- |
| `PI_LAZY_SKILL_ROUTING` | `adaptive` | `safe`, `full`, or `adaptive`; overrides file config. |
| `PI_LAZY_SKILL_DESCRIPTION_MAX` | unset | Legacy override for `maxDescriptionCharacters`, integer `0..1024`. Deprecated in favor of JSON config. |
| `PI_LAZY_SKILL_MAX_SOURCE_BYTES` | `16777216` | Integer `1024..67108864`; overrides file config. |
| `PI_LAZY_SKILL_FILE_LIMIT` | unset | Legacy override for `resourceFileSampleLimit`, integer `0..50`. Deprecated in favor of JSON config. |
| `PI_LAZY_SKILL_DISABLE` | unset/false | `1`, `true`, or `yes` disables the extension; `0`, `false`, or `no` enables it. |

Invalid environment values emit a warning and retain the lower-precedence value. Use of either renamed legacy numeric variable emits one deprecation warning per extension runtime.

## Canonical scope and conflicts

The extension consumes `systemPromptOptions.skills` and skill entries from `pi.getCommands()`. Consequently it supports exactly what Pi exposes:

- global user skills;
- trusted project skills;
- package-provided skills;
- settings-provided paths;
- temporary or CLI-provided paths;
- Pi's resolved duplicate winner.

`sourceInfo` is preserved in runtime records and user-facing selectors, but omitted from the model catalog.

At agent start the extension checks the resolved `skill` tool in `pi.getAllTools()` and checks activity with `pi.getActiveTools()`:

- own active tool: normal lazy catalog and loading;
- foreign winner: hide the model catalog, block every model `skill` call with `SKILL_TOOL_CONFLICT`, and emit one warning naming both observable sources;
- own inactive/missing tool: leave permissive native behavior alone, but remove native skill metadata when restrictive policy can be verified safely.

Explicit canonical commands remain available under a foreign tool winner and still obey policy. Pi exposes only the resolved winner, so this detects the observable conflict; it does not claim to enumerate overwritten registrations.

Prompt replacement computes Pi's exact native skill section with `formatSkillsForPrompt()`, replaces exactly one occurrence, and never uses a broad XML regex. Zero or multiple occurrences are integration failures. Restrictive or invalid policy fails closed if safe replacement cannot be proved.

## Security boundary

This controls disclosure and invocation through the skill integration. It does not sandbox arbitrary filesystem access or erase information already sent to the model.

- It controls what this extension exposes and loads as a skill.
- It does not sandbox shell commands, file reads, network requests, MCP calls, or other tools after instructions load.
- Those capabilities depend on Pi's tool, permission, sandbox, and project-trust configuration.
- Project policy is read only for a Pi-trusted project.
- Skill files follow Pi's canonical resource trust model.
- Skill frontmatter cannot grant permission or override external policy.
- A denied skill's name, description, path, and body are not exposed to the model through this extension.
- Trusted extension code runs in the host process and can evade extension-level policy. This package does not claim a host-level security boundary or equivalence to OpenCode's full permission system.

## Context benchmark

Run from the repository root:

```sh
npm run benchmark:lazy-skills
```

The benchmark uses Pi 0.85.1's `estimateTokens()` and reports exact UTF-8 bytes plus component token estimates. It compares stock Pi, an OpenCode-style verbose name/description/location catalog, frozen v0.1.6 full/adaptive serialization, and v0.3.0 safe/adaptive at 1, 5, 10, 25, 50, and 100 skills.

Observed on the release-validation workstation:

| Skills | Stock Pi catalog | OpenCode-style verbose catalog | v0.1.6 full catalog/total | v0.1.6 adaptive catalog/total | v0.3.0 safe catalog/total | v0.3.0 adaptive catalog/total |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 166 | 83 | 68 / 150 | 68 / 150 | 54 / 304 | 54 / 384 |
| 5 | 459 | 376 | 244 / 326 | 244 / 326 | 230 / 480 | 230 / 560 |
| 10 | 825 | 742 | 464 / 546 | 464 / 546 | 450 / 700 | 450 / 780 |
| 25 | 1,931 | 1,849 | 1,132 / 1,214 | 1,132 / 1,214 | 1,117 / 1,367 | 1,117 / 1,447 |
| 50 | 3,775 | 3,692 | 2,244 / 2,326 | 2,244 / 2,326 | 2,230 / 2,480 | 2,230 / 2,560 |
| 100 | 7,462 | 7,380 | 4,469 / 4,551 | 4,469 / 4,551 | 4,455 / 4,705 | 712 / 1,042 |

Values are tokens. Version columns are catalog / total extension-attributable context. v0.3.0's 250-token fixed estimate includes the `skill` schema (92), snippet (15), and guideline (22), plus `skill_search` schema (63), snippet (15), and guideline (43). Adaptive totals also include the 80-token stable instruction prefix. Therefore a one-skill v0.3.0 installation has higher total fixed-plus-variable context than stock Pi and v0.1.6. Safe catalogs still beat stock Pi, the verbose catalog, and frozen v0.1.6 full at every measured nonempty size. Skill-only totals (excluding `skill_search`) first beat stock Pi at five representative skills; including `skill_search` the break-even is ten.

Adaptive uses the full compact catalog through 50 representative skills because that catalog fits `catalogTokenBudget` (4096). That is successful adaptation, not a failed optimization. At 100 skills the catalog exceeds the budget, so adaptive keeps a shortlist (nine described skills in this corpus, including the exact-name pin) and discovery names. That large-catalog total stays below both safe and frozen v0.1.6 full.

A separate quality gate pads the frozen routing corpus with 80 distractors and requires safe-parity: uncertain prompts disclose the full catalog; confident shortlists include every unlimited-ranking load target; required skills are loadable before the dependent action. Multi-skill, exclusion, misleading-name, topic-change, and referential cases are included.

Across the measured 1-to-100-skill corpus, the safe catalog reduction versus stock Pi ranges from 67.5% to 40.3% by estimated tokens (67.6% to 40.3% by UTF-8 bytes). The benchmark enforces catalog, inexpensive-expansion, large-catalog, and loaded-payload gates rather than concealing the required v0.3.0 tool-schema overhead.

Frontmatter removal reduced the measured loaded `alpha` payload from 353 bytes/89 tokens to 178 bytes/45 tokens, and the real-world incident fixture from 10,288 bytes/2,569 tokens to 9,432 bytes/2,355 tokens.

These are reproducible component estimates, not complete provider request counts, prices, or cross-tokenizer guarantees. Timings are machine-specific. Adaptive matches `safe` on uncertain prompts and keeps every ranking load target described on confident shortlists. No credentialed live-model evaluation is part of the repository validation.

## Migration from v0.2.0

- Default routing changes from `safe` to `adaptive`. Set `"routing": "safe"` to keep the v0.2.0 always-on full-description catalog.
- Adaptive now expands to the full policy-filtered catalog when that catalog fits `catalogTokenBudget` (default 4096 tokens). A fixed candidate cap is not a correctness limit. When the catalog cannot fit, required skills still receive complete descriptions on the shortlist; remaining names are recovery, not the success path.
- Exact-name mentions are pinned without raising the score floor for other candidates.
- `skill_search` is registered next to `skill`. Browse-all pagination covers every policy-visible skill exactly once per snapshot.
- Adaptive routing catalogs are task-local custom messages; the system prefix keeps stable instructions and tool schemas.
- A failed rebuild blocks new skill operations until a successful rebuild. It no longer leaves the previous generation loadable.
- Unsafe prompt integration preserves unrelated host instructions and aborts the provider request.
- Continuation JSON includes `rev`. Continuing without a matching revision fails closed.
- `full` remains a deprecated alias for `safe`.
- The supported Pi peer range is unchanged: `>=0.85.1 <0.86.0`.

## Migration from v0.1.x

- v0.2.0 changed the default from `adaptive` to `safe`, stripped frontmatter from loaded bodies, and added policy. v0.3.0 changes the default back to `adaptive` with discovery, fail-closed publication, and measured expansion rather than a hidden shortlist.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run pack:check
npm run benchmark:lazy-skills
```

## License

Apache License 2.0. See [`LICENSE`](LICENSE).
