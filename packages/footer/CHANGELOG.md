# Changelog

## 0.2.1

- Derive the compaction marker from global and trusted-project settings, including model overrides supported by the host.
- Hide the marker when compaction is disabled or settings cannot be read; refresh before turns without writing settings.
- Handle Windows drive and UNC project labels; show `off` when a reasoning model has no thinking level.
- Replace unchecked source types with Pi's public types and validate Pi 0.85.1 and 1.0.0.
- Apply lint cleanup without changing rendered output or routing results.
