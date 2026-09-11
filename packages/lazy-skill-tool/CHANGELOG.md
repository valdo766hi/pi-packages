# Changelog

## 0.3.0

### Changed

- Made `adaptive` the default routing mode. Adaptive starts compact, preserves complete discovery, and expands to the full policy-filtered catalog when the catalog is inexpensive, evidence is weak, or the selection cutoff is ambiguous.
- Kept `safe` as an explicit override and `full` as a deprecated alias for `safe`.
- Separated exact-name pinning from relevance scoring so a mentioned name cannot raise the cutoff for other skills.
- Uncertain ranking now always discloses the full policy-filtered catalog, matching `safe`, even when that catalog exceeds `catalogTokenBudget`. Compactness applies only to confident shortlists, which must include every unlimited-ranking load target.
- Stopped treating a five-candidate cap as a silent correctness limit; near-tied exclusions expand or fall back, and pinned descriptions are kept when the full catalog cannot fit.
- Moved adaptive routing catalogs into task-local custom messages and kept stable instructions in the system prefix.
- Publication is now `ready` or `blocked`. A failed rebuild invalidates one-time tickets and blocks new skill operations until a successful rebuild.
- Unsafe prompt integration preserves unrelated host instructions and aborts the in-flight provider request from `context` / `before_provider_request` rather than replacing the entire system prompt.
- Continuation state includes a source revision. Mixed-version pagination fails closed.

### Added

- `skill_search` for full-registry metadata search and deterministic browse-all pagination. Cursors bind to the snapshot fingerprint and query.
- `catalogTokenBudget` (default 4096; zero means the full catalog always fits).
- A padded-catalog quality gate: required skills must keep complete descriptions under a forced shortlist, including multi-skill, exclusion, misleading-name, and referential cases.
- Authorization recheck after async approval or file reads, before returning a skill body.

### Security

- Ranking, search, fallback, and retries cannot weaken `allow` / `ask` / `deny` or `disable-model-invocation`.
- Denied skills are absent from catalogs and search results.
- Invalid policy or failed publication blocks skill operations instead of serving a previous generation.

### Migration

- Set `"routing": "safe"` to restore the v0.2.0 always-on full-description catalog.
- Models that continue large skills must pass the returned `rev`.
- See the README for the adaptive decision table and discovery contract.

## 0.2.0

### Changed

- Made `safe` routing the default. Safe retains every complete normalized description for policy-visible, model-invokable skills while omitting paths.
- Kept `full` as a deprecated alias for `safe`; retained `adaptive` as an explicit experimental mode.
- Changed successful loads to return the frontmatter-stripped Markdown body plus compact base/continuation JSON. Pagination offsets now refer to the stripped body.
- Raised the supported Pi range to `>=0.85.1 <0.86.0`. Pi 0.85.0's published top-level module does not import cleanly because it references an undeclared package, so v0.2.0 does not claim it as a supported minimum.
- Added a 16-MiB default source ceiling and kept resource sampling disabled by default.

### Added

- Global and trusted-project JSON configuration with a published JSON Schema.
- Ordered exact-name wildcard policy with `allow`, `ask`, and `deny`; only `*` and `?` are wildcard characters, and the last matching rule wins.
- Policy enforcement at catalog, model tool-call, own execution, explicit command, and final context boundaries.
- Interactive once/session/reject approval behavior, with fail-closed noninteractive `ask` handling.
- `/lazy-skill <name> [args]`, `/lazy-skill:<name> [args]`, dynamic completion, selector metadata, and native `/skill:<name>` policy interception.
- Observable resolved-tool ownership checks and `SKILL_TOOL_CONFLICT` fail-closed behavior.
- Immutable generation snapshots combining canonical skills, policy, visibility, safe catalog, and optional adaptive index.
- Stable typed error codes for policy, authorization, ownership, validation, pagination, encoding, and I/O failures.

### Security

- Invalid or unreadable existing policy files now enter `POLICY_INVALID` rather than falling back to permissive behavior.
- Denied skills are omitted from the model catalog and blocked from model and explicit loading.
- Exact whole-message Pi skill expansions are revalidated against canonical name, canonical path, current body, policy fingerprint, and invocation-scoped approval before provider context.
- `disable-model-invocation` remains unavailable to the model while explicit native invocation remains possible subject to policy.

### Migration

- Default routing changes from `adaptive` to `safe`.
- Frontmatter is no longer model-facing, and continuation offsets no longer count frontmatter lines.
- `PI_LAZY_SKILL_DESCRIPTION_MAX` and `PI_LAZY_SKILL_FILE_LIMIT` remain compatible for v0.2.0 but emit one deprecation warning; prefer `maxDescriptionCharacters` and `resourceFileSampleLimit` in `lazy-skill.json`.
- Restrictive policies can intentionally block loads that v0.1.x allowed.

See the README for configuration precedence, permission semantics, measured context trade-offs, and security boundaries.
