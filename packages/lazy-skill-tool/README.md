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
selects that exact skill.

## Architecture

```text
Pi discovery
    │
    ▼
current skill snapshot
    │
    ├── compact <available_skills> → model context
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
 body + baseDir + sampled resources
```

The tool is registered once when the extension initializes. Each
`before_agent_start` event builds a new immutable-by-convention registry from
`event.systemPromptOptions.skills` and replaces the active snapshot atomically.
The dynamic registry is never captured in the tool description, so catalog
refreshes cannot leave the model-facing catalog and tool state out of sync. If
Pi has disabled the `skill` tool, the extension leaves the native prompt alone;
if `skill` is active without `read`, it appends the compact catalog instead of
trying to rewrite a missing native section.

## Prior art

The central lazy-loading idea was demonstrated by
[`arhen/pi-core-skill-tool`](https://github.com/arhen/pi-core-skill-tool), now
maintained in the
[`pi-extensions` monorepo](https://github.com/arhen/pi-extensions/tree/main/packages/core/pi-core-skill-tool).
That project is useful prior art for Pi's canonical skill discovery and the
single-tool progressive-disclosure model.

This implementation is independent and intentionally differs by separating
static tool registration from dynamic catalog state, handling empty refreshes,
using a bounded prompt transformer, loading files asynchronously, sampling
nearby resources, and testing lifecycle/security behavior.

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

The package requires Pi `@earendil-works/pi-coding-agent` `>=0.69.0 <1.0.0`
and `typebox` `>=1.3.7 <2.0.0`. It was tested with Pi
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
| `PI_LAZY_SKILL_DESCRIPTION_MAX` | `240` | `0` disables truncation; otherwise `0..1024`. Long descriptions are normalized and shortened at a word boundary with one ellipsis. |
| `PI_LAZY_SKILL_FILE_LIMIT` | `10` | `0..50` related files. |
| `PI_LAZY_SKILL_DISABLE` | unset | `1`, `true`, or `yes` disables this extension and leaves Pi's native skill behavior unchanged. |

Invalid numeric values fall back to their defaults and emit one warning. The
file sampler also stops after a bounded directory traversal and never follows
symbolic-link directories.

## Loading behavior

The model can provide only an exact skill name:

```json
{"name":"pdf-processing"}
```

The extension never turns that name into a filesystem path. It looks up the
name in Pi's current canonical registry and reads only the `filePath` supplied
by Pi. Unknown names, path-like names, disabled skills, missing files, invalid
frontmatter, and aborted calls fail cleanly.

A successful result contains:

- the frontmatter-free `SKILL.md` body;
- the skill base directory for resolving relative references;
- a sorted, bounded sample of nearby files, excluding `SKILL.md`. Directory
  enumeration is capped and filesystem order is not treated as deterministic.
- skill bodies larger than 50 KiB are rejected before parsing to keep one tool
  call from consuming unbounded memory or context.

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

The benchmark compares the UTF-8 bytes and characters of the stock and compact
representations using the checked-in fixture skills. It reports measurements
only; no universal token-saving claim is made.

## License

Apache License 2.0. See [`LICENSE`](LICENSE).
