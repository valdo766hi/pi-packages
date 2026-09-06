# `@valdo766hi/pi-lazy-skill-tool`

A Pi extension that keeps skill routing metadata compact and loads instructions only after an exact-name `skill` call.

Pi remains the source of truth for skill discovery, duplicate resolution, trust, package/settings paths, temporary CLI paths, and canonical file locations. This extension does not scan for skills independently.

## What v0.2.0 does

- Uses a compact, path-free catalog with every complete normalized description by default.
- Registers one exact-name `skill` tool.
- Loads the current `SKILL.md` body without YAML frontmatter.
- Supports external `allow`, `ask`, and `deny` policy.
- Applies policy to catalog visibility, model tool calls, explicit commands, and final model context.
- Adds `/lazy-skill <name> [args]` and `/lazy-skill:<name> [args]` while retaining Pi's native `/skill:<name>` expansion.
- Detects when another extension owns the resolved `skill` tool and blocks model skill loading rather than assuming a compatible contract.

“Lazy” describes model-context injection. Pi still reads skill frontmatter during canonical resource discovery.

## Install and compatibility

```sh
pi install npm:@valdo766hi/pi-lazy-skill-tool
```

The package requires:

- Node.js `>=22.19.0`;
- `@earendil-works/pi-coding-agent >=0.85.1 <0.86.0`;
- `typebox >=1.3.7 <2.0.0` supplied by Pi.

v0.2.0 uses Pi 0.85's canonical skill formatter, anchored skill-block parser, command registry, tool ownership metadata, active-tool API, project trust state, and composed autocomplete API. The verified minimum and current compatible release is `0.85.1`. Pi 0.85.0 exposes the needed type surface, but its published top-level module fails a clean import because it references an undeclared `@earendil-works/pi-server`; this package therefore does not claim 0.85.0 support. It does not claim compatibility outside the 0.85 minor series.

## Safe routing is the default

`safe` retains the complete normalized description of every policy-visible, model-invokable skill while omitting paths:

```xml
<available_skills>
<skill name="pdfs">Create, edit, inspect, extract, redact, convert, and compare PDF files.</skill>
<skill name="slides">Create and edit PowerPoint presentations and other slide-based artifacts.</skill>
</available_skills>
```

Catalog entries are sorted by exact name. XML-sensitive text is escaped. Whitespace inside descriptions is normalized to one line, but descriptions are not truncated unless `maxDescriptionCharacters` is explicitly set above zero.

Visibility rules:

- `allow` and `ask` skills appear with complete descriptions.
- `deny` skills do not appear.
- A skill with `disable-model-invocation: true` never appears, regardless of policy.
- No skill location, scope, package, source, or policy label appears in model-visible catalog entries.

`full` is a deprecated alias for `safe` in v0.2.0. `adaptive` remains an experimental opt-in. It describes a deterministic local shortlist and preserves every omitted exact name in `other_skill_names`; uncertain queries fall back to safe. Adaptive routing has not been shown to provide the same structural routing-safety guarantee as safe mode. There are no embeddings, network calls, routing-model calls, filesystem watchers, or independent discovery caches.

## Exact-name loading

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
{"base":"/canonical/skills/pdfs","next":{"offset":121,"column":1}}
```

The body is not wrapped in XML, JSON, CDATA, or a Markdown fence. The exact skill name, canonical path, source information, policy decision, and diagnostics remain in non-model tool details.

Offsets and columns are one-based and relative to the **frontmatter-stripped body**, not the original file. Each chunk uses Pi's 2,000-line/50-KiB read limits. A single oversized line is split at a UTF-8-safe character boundary and continued with the returned line and column.

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

Example using the immutable v0.2.0 schema URL:

```json
{
  "$schema": "https://raw.githubusercontent.com/valdo766hi/pi-packages/pi-lazy-skill-tool-0.2.0/packages/lazy-skill-tool/schema/lazy-skill.schema.json",
  "routing": "safe",
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
  "resourceFileSampleLimit": 0
}
```

A scalar is shorthand for a default with no rules:

```json
{"permission":{"skill":"ask"}}
```

### Permission semantics

Actions are exactly:

- `allow`: catalog-visible when model-invokable and loads without approval;
- `ask`: catalog-visible when model-invokable and requires approval before each load;
- `deny`: hidden from this extension's model catalog and blocked everywhere.

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
| `PI_LAZY_SKILL_ROUTING` | `safe` | `safe`, `full`, or `adaptive`; overrides file config. |
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

This is a skill visibility-and-loading policy, not an operating-system sandbox.

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

The benchmark uses Pi 0.85.1's `estimateTokens()` and reports exact UTF-8 bytes plus component token estimates. It compares stock Pi, an OpenCode-style verbose name/description/location catalog, frozen v0.1.6 full/adaptive serialization, and v0.2.0 safe/adaptive at 1, 5, 10, 25, 50, and 100 skills.

Observed on the release-validation workstation:

| Skills | Stock Pi catalog | OpenCode-style verbose catalog | v0.1.6 full catalog/total | v0.1.6 adaptive catalog/total | v0.2.0 safe catalog/total | v0.2.0 adaptive catalog/total |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 166 | 83 | 68 / 140 | 68 / 140 | 54 / 173 | 54 / 173 |
| 5 | 459 | 376 | 244 / 316 | 106 / 178 | 230 / 349 | 76 / 195 |
| 10 | 825 | 742 | 464 / 536 | 134 / 206 | 450 / 569 | 91 / 210 |
| 25 | 1,931 | 1,849 | 1,132 / 1,204 | 216 / 288 | 1,117 / 1,236 | 136 / 255 |
| 50 | 3,775 | 3,692 | 2,244 / 2,316 | 354 / 426 | 2,230 / 2,349 | 211 / 330 |
| 100 | 7,462 | 7,380 | 4,469 / 4,541 | 629 / 701 | 4,455 / 4,574 | 361 / 480 |

Values are tokens. Version columns are catalog / total extension-attributable context. v0.2.0's fixed 119-token estimate includes its required tool schema (82), prompt snippet (15), and guideline (22); v0.1.6's fixed estimate was its 72-token tool schema. Therefore a one-skill v0.2.0 safe installation has higher total fixed-plus-variable context than stock Pi and v0.1.6 full. Safe first beats stock Pi total context at five representative skills. Its catalog alone is smaller than stock Pi, the verbose catalog, and frozen v0.1.6 full at every measured nonempty size. The net total increase over v0.1.6 full is 32–33 tokens across this corpus and falls below one percent of the v0.1.6 total by 100 skills.

Across the measured 1-to-100-skill corpus, the safe catalog reduction versus stock Pi ranges from 67.5% to 40.3% by estimated tokens (67.6% to 40.3% by UTF-8 bytes). v0.2.0 adaptive's catalog is smaller than frozen v0.1.6 adaptive throughout the measured corpus; fixed overhead makes its total 33 tokens higher at one skill, 17 higher at five, 4 higher at ten, and lower from 25 onward. The benchmark enforces catalog and loaded-payload no-regression gates rather than concealing the required v0.2.0 metadata overhead.

Frontmatter removal reduced the measured loaded `alpha` payload from 353 bytes/89 tokens to 178 bytes/45 tokens, and the real-world incident fixture from 10,288 bytes/2,569 tokens to 9,432 bytes/2,355 tokens.

These are reproducible component estimates, not complete provider request counts, prices, or cross-tokenizer guarantees. Timings are machine-specific. Safe guarantees catalog visibility of complete descriptions; the benchmark does not measure or claim perfect live-model selection accuracy. No credentialed live-model evaluation is part of the repository validation.

## Migration from v0.1.x

- Default routing changes from `adaptive` to `safe`.
- `full` is a deprecated alias for `safe` for v0.2.0.
- Safe preserves every complete policy-visible, model-invokable description.
- Paths remain absent from the compact catalog.
- Loaded model-facing instructions no longer include YAML frontmatter.
- Continuation offsets now refer to the stripped body.
- Resource sampling remains opt-in and defaults to zero.
- The default source ceiling is 16 MiB.
- Restrictive policy can block commands that v0.1.x loaded silently.
- Native `/skill:` is now intercepted by the same external policy.
- `PI_LAZY_SKILL_DESCRIPTION_MAX` and `PI_LAZY_SKILL_FILE_LIMIT` remain supported for v0.2.0 but are deprecated in favor of JSON fields.
- The supported Pi peer range changes from `>=0.84.2 <0.85.0` to `>=0.85.1 <0.86.0`.

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
