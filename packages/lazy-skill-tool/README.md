# `@valdo766hi/pi-lazy-skill-tool`

A Pi extension that makes skill loading lazy:

```text
small skill metadata stays available for routing
full SKILL.md instructions load only after skill(name)
```

Pi remains responsible for discovering skills. This package replaces Pi's
verbose model-facing skill catalog with a compact catalog and registers one
stable `skill` tool for exact-name loading.

## Why

Stock Pi puts each discovered skill's name, description, and file location in
the system prompt. The model can then use `read` to open a skill file, but the
full catalog cost is paid on every run.

This extension keeps model-side skill discovery while moving the full load to
an explicit tool call. Skill bodies are not added to context until the model
selects that exact skill. Pi still reads skill files during canonical discovery
to extract frontmatter; “lazy” here means model-context injection, not startup
filesystem discovery.

## Architecture

```text
Pi discovery
    │
    ▼
current skill snapshot
    │
    ├── compact <skills> → model context
    │
    └── exact-name registry
             │
             ▼
         skill(name)
             │
             ▼
          SKILL.md
             │
             ▼
 body + baseDir + optional resource sample
```

The tool is registered once when the extension initializes. Each
`before_agent_start` event builds a new immutable-by-convention registry from
`event.systemPromptOptions.skills` and replaces the active snapshot atomically.
The dynamic registry is never captured in the tool description, so catalog
refreshes cannot leave the model-facing catalog and tool state out of sync. If
Pi has disabled the `skill` tool, the extension leaves the native prompt alone;
if `skill` is active without `read`, it appends the compact catalog instead of
trying to rewrite a missing native section.

Use only one extension that registers a tool named `skill`. Pi resolves duplicate
tool names by load order, but does not expose enough ownership information here
to guarantee that this extension rewrites the prompt for the winning provider.

## Prior art

The central lazy-loading idea was demonstrated by
[`arhen/pi-core-skill-tool`](https://github.com/arhen/pi-core-skill-tool), now
maintained in the
[`pi-extensions` monorepo](https://github.com/arhen/pi-extensions/tree/main/packages/core/pi-core-skill-tool).
That project is useful prior art for Pi's canonical skill discovery and the
single-tool progressive-disclosure model.

This implementation is independent and intentionally differs by separating
static tool registration from dynamic catalog state, handling empty refreshes,
using a bounded prompt transformer, loading files asynchronously, making nearby
resource sampling opt-in, and testing lifecycle/security behavior.

The lazy-loading behavior is also informed by
[OpenCode's skill tool](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/skill.ts).
The borrowed concepts are exact-name resolution, lazy full-content loading,
base-directory context, bounded related-file sampling, and permission-aware
loading where the host exposes an equivalent. This package does not copy
OpenCode's framework or discovery service.

## Install

```sh
pi install npm:@valdo766hi/pi-lazy-skill-tool
```

[View this package on npm](https://www.npmjs.com/package/@valdo766hi/pi-lazy-skill-tool)

The package requires Node.js `>=22.19.0`, Pi
`@earendil-works/pi-coding-agent` `>=0.84.2 <0.85.0`, and `typebox`
`>=1.3.7 <2.0.0`. It is tested with Pi
`@earendil-works/pi-coding-agent@0.84.2`. The test harness uses Pi's canonical
`loadSkillsFromDir` and `formatSkillsForPrompt` functions before exercising the
extension lifecycle.
A live interactive model/provider request is not part of the credential-free
validation. Pi supplies the runtime and `typebox`; neither is bundled into
this package.

## Configuration

All settings are read when the extension loads:

| Variable | Default | Valid range / behavior |
| --- | ---: | --- |
| `PI_LAZY_SKILL_DESCRIPTION_MAX` | `0` | `0` preserves the complete description; `1..1024` opts into shortening at a word boundary with one ellipsis. |
| `PI_LAZY_SKILL_FILE_LIMIT` | `0` | `0` skips directory traversal; `1..50` adds a bounded related-file sample. |
| `PI_LAZY_SKILL_DISABLE` | unset | `1`, `true`, or `yes` disables this extension and leaves Pi's native skill behavior unchanged. |

Invalid numeric values fall back to their defaults and emit one warning. When
enabled, the sampler stops as soon as its result budget is filled, visits at
most 64 directories, reads at most 1024 entries per directory, skips hidden
entries, `.git`, and `node_modules`, and never follows child symbolic-link
entries. A symlink supplied by Pi as the skill's root is still opened as the
root; project trust and root provenance remain Pi's responsibility.

## Loading behavior

The model can provide only an exact skill name:

```json
{"name":"pdf-processing"}
```

The compact catalog uses one complete, unambiguous record per skill:

```xml
<skills>
<skill name="pdf-processing">Complete description and routing triggers.</skill>
</skills>
```

The name remains the exact registry key; the description is complete by default.
Name attributes use JSON escapes before XML escaping, so non-standard names with
whitespace, controls, or literal backslashes remain unambiguous.

The extension never turns that name into a filesystem path. It looks up the
name in Pi's current canonical registry and reads only the `filePath` supplied
by Pi. Unknown input—including unknown path-like input—has no filesystem
semantics. Disabled skills, missing files, changed names, malformed or
unterminated frontmatter, invalid UTF-8, empty instructions, and aborted calls
fail cleanly. Pi remains authoritative if it canonically discovers a
non-standard but exact skill name.

A successful result contains two text items:

1. the validated raw `SKILL.md`, including standard frontmatter such as
   `compatibility`, `allowed-tools`, and `metadata`;
2. compact JSON context containing the skill name, base directory, canonical
   file path relative to that base, and only the continuation or sampled-file
   fields that are needed.

Normal context:

```json
{"skill":"pdf-processing","base":"/skills/pdf-processing","fileFromBase":"SKILL.md"}
```

The raw source is never wrapped in XML, JSON, Markdown, or CDATA, so its bytes
remain unchanged. When explicitly configured, sampled files are relative to
`base`; the default performs no directory traversal.

Descriptions are complete by default so late trigger phrases remain available for
routing. Skill-file output uses Pi's regular read limits: 2,000 lines or 50 KiB
per call. A large skill is not rejected. The result provides the next source line,
and the model continues with the same tool:

```json
{"name":"large-skill","offset":321}
```

The loader uses Pi's exported truncation implementation, so ordinary chunk
boundaries match regular `read` behavior. The raw source chunk is returned as its
own unmodified text item; escaped path and continuation metadata are separate, so
source such as `]]>` cannot be rewritten or inflate through wrapper escaping. It
reads and validates the current full skill file before returning a bounded chunk,
just as Pi discovery and regular file loading read the source before limiting
model-facing output. If one source line
alone exceeds 50 KiB, the same `skill` tool returns bounded UTF-8-safe segments and
adds a `column` continuation automatically; this also works when `read` and `bash`
are disabled:

```json
{"name":"large-skill","offset":321,"column":25001}
```

Skills with `disable-model-invocation: true` are omitted from the compact
catalog and cannot be loaded through this tool. Pi's explicit `/skill:name`
command remains independent and is not changed by this extension. Project
trust and discovery precedence remain Pi's responsibility.

## Development

From the repository root:

```sh
npm ci
npm run typecheck
npm test
npm run pack:check
npm run benchmark:lazy-skills
```

The benchmark compares the complete static routing context—Pi's native catalog
against the compact catalog plus the serialized `skill` tool schema—using Pi's
real `formatSkillsForPrompt()` and `estimateTokens()` implementations. It also
reports catalog-only diagnostics, selected-skill first-exchange cost, cumulative
first-load cost, and warm p50/p95 load timings. Common built-in
tool schemas are excluded from both sides. Timing is machine-specific; token
and byte savings are measured claims for the listed fixtures and scales, not a
universal tokenizer claim.

## License

Apache License 2.0. See [`LICENSE`](LICENSE).
