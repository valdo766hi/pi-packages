# Changelog

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
