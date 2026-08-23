# pi-lazy-skill-tool quality and performance plan

## Goal

Keep the extension small while improving its measured performance, token efficiency,
filesystem bounds, and load-time validation. Target a fresh reviewer performance
rating of at least 9/10, but claim it only when benchmarks and review support it.

Pi remains responsible for canonical skill discovery, precedence, trust, and reloads.
This extension optimizes only the model-facing catalog and explicit `skill(name)` load
path; it will not replace Pi's discovery service.

## Baseline (`5be8af4`)

Detailed local baseline: `.pi/lazy-skill-tool-performance-baseline.json`.

- Reviewer: overall 7.8/10, performance 6.8/10.
- Existing fixture benchmark: 873 → 700 bytes (19.8% reduction).
- Pi-native fixture comparison: 962 → 700 bytes (27.2% reduction).
- Current default load (`fileLimit=10`, 500 warm iterations): p50 0.235 ms,
  p95 0.592 ms.
- No-sampling load (`fileLimit=0`): p50 0.062 ms, p95 0.149 ms.

Warm timing values are machine-specific. Byte counts and filesystem operation shape
are the deterministic acceptance evidence.

## Work

- [x] Make related-file sampling opt-in (`fileLimit=0` by default).
- [x] Stop opt-in traversal as soon as its result budget is filled.
- [x] Skip hidden entries, `.git`, and `node_modules`; never follow child symlinks.
- [x] Keep deterministic ordering and hard directory/entry caps.
- [x] Compact catalog XML and guidance without dropping routing metadata.
- [x] Remove redundant skill-result markup and omit empty file sections.
- [x] Validate UTF-8, frontmatter closure, canonical name, model visibility, and body.
- [x] Benchmark against Pi's real `formatSkillsForPrompt()` output.
- [x] Add scaled catalog and selected-skill latency benchmarks.
- [x] Add focused regression and operation-bound tests.
- [x] Update README, configuration defaults, and package version metadata.
- [x] Run typecheck, tests, pack check, benchmark, diagnostics, and diff checks.
- [x] Obtain a fresh performance-focused review and record the resulting rating.
- [x] Preserve complete routing descriptions by default; keep truncation opt-in.
- [x] Match Pi's regular 2,000-line / 50 KiB read boundaries for skill output.
- [x] Add same-tool continuation for large skill instructions instead of rejecting them.
- [x] Add a checked-in 9+ KiB real-world skill and end-to-end fidelity tests.
- [x] Obtain final xhigh parity approval with no quality category below 9/10.

## Acceptance targets

- At least 45% fixture catalog byte reduction against Pi's real formatter.
- At least 30% catalog byte reduction for 10, 50, and 100 synthetic skills.
- Default selected-skill loading performs no directory traversal.
- Opt-in sampling terminates at its configured limit and remains deterministically
  bounded on wide/deep trees.
- Default load latency materially improves from the recorded current default and
  remains close to a bounded raw-read/frontmatter baseline on this workstation.
- No new runtime dependency, body cache, index, remote registry, or custom discovery
  service.
- All existing and new checks pass with no blocking diagnostics.

## Outcome

- Package version: `0.1.2`.
- Fixture catalog: 962 → 494 bytes (48.6% reduction).
- Synthetic catalogs: 36.5% (10), 33.7% (50), and 33.3% (100).
- Real-world catalog: 1,141 → 772 bytes (32.3% reduction) while preserving a
  decisive trigger after character 240.
- Default load: p50 0.064 ms, p95 0.096 ms in the latest recorded run.
- Full default tool: p50 0.062 ms, p95 0.105 ms, 561 result bytes.
- Recorded old default: p50 0.235 ms, p95 0.592 ms.
- Validation: 58 tests, typecheck, pack dry-run, benchmark, diagnostics, and
  `git diff --check` passed.
- Performance-focused review: overall 8.9/10 and performance 9.2/10.
- A later xhigh parity review scored overall 8.0, routing 7.3, and parity 7.6,
  and correctly blocked approval because default 240-character description
  truncation could hide late trigger phrases. It also identified the 50 KiB hard
  rejection as a regular-Pi parity gap.
- Both initial parity findings are addressed: complete descriptions are the
  default, and large skills use Pi's exported regular-read truncation with
  same-tool continuation.
- A subsequent xhigh review found an oversized-single-line zero-progress path and
  that stripping standard frontmatter diverged from Pi's normal model/read route.
  The loader now returns validated raw `SKILL.md`, including `compatibility`,
  `allowed-tools`, and metadata; oversized individual lines continue in bounded,
  UTF-8-safe same-tool segments even when `read` and `bash` are disabled.
- Checked-in real-world, 50 KiB, 2,000-line, oversized-single-line, skill-only,
  literal-CDATA, and adversarial output-size tests cover routing, raw-file fidelity,
  exact continuation, strict progress, and bounded serialization. Raw skill chunks
  are separate text items, so metadata escaping cannot mutate or inflate them.
- Final xhigh review: **APPROVED**, with no blockers, major findings, or minor
  findings. Ratings: overall 9.5, regular-skill parity 9.4, routing 9.5,
  loaded-skill fidelity 9.8, performance 9.5, security 9.4, maintainability 9.3,
  and tests 9.7.

Detailed local result: `.pi/lazy-skill-tool-performance-after.json`.
