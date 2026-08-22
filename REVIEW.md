# Engineering Review: `packages/yolo`

This document records the initial review findings and the post-implementation disposition.

## Initial review summary (before implementation)

The current implementation does **not** fully satisfy the requested contract:

1. **YOLO off by default: not satisfied.** When `yolo-state.json` is absent, the extension imports `yoloMode: true` from the native permission config and persists it. A new install can therefore enable YOLO without an explicit `/yolo on`.
2. **Bypass `ask` but never bypass `deny`: only partially satisfied.** The installed permission system's happy-path rewrite changes `ask` to `allow` and leaves the final effective `deny` unchanged. Scope precedence, fail-closed handling, stale config, and concurrent writes can still produce an effective permission different from the user's intended deny policy.
3. **Persistence: happy-path only.** The separate state file survives normal restart/reload/compaction, but project configuration, malformed files, partial two-file writes, concurrent sessions, config rewrites, and extension ordering can make the displayed, persisted, and effective states disagree.

The safest long-term design is for the permission system to own the persisted toggle and expose a supported live `get/setYoloMode` API. `pi-yolo` should be a thin command/status alias. Directly editing another extension's private config file cannot reliably guarantee security precedence, atomicity, or cache coherence.

## Post-implementation status

Implemented in the working tree:

- Missing state now defaults OFF and never migrates native `yoloMode: true`.
- State is versioned and keyed by Pi session ID, so reload/resume/restart/compaction of the same session restores it while new session IDs start OFF.
- Native config parsing accepts the permission system's JSONC format, validates the native schema defensively (including safe integer bounds), preserves permission rules, refuses symlink replacement, supports legacy global and legacy extension configs through a new override, uses unique temporary files, and verifies the committed value.
- Invalid state, unverifiable project trust, project `yoloMode` conflicts, and failed reconciliation show `YOLO: ERROR`; input is handled, unsafe tool calls are blocked/terminated, and agent/turn boundaries request an abort when state is unknown.
- Reload failure is reported without discarding a committed toggle; the implementation is typed and package/release/test coverage was updated.

Still unresolved and requiring an upstream permission-system capability:

- The native `yoloMode` value is global, so it cannot provide truly independent effective YOLO modes for concurrent sessions/subagents.
- Trusted project runtime config can still influence the native permission system; the extension can detect conflicts and fail safe, but cannot override project precedence or provide a session-scoped runtime override.
- Cross-process config writers can still race between the final read and rename; a shared permission-system lock/transaction is required for a complete guarantee.
- The repository tests remain extension-level tests; a real two-extension permission-system integration suite is still needed.
- Local tests now cover pre-lifecycle tool blocking, missing trust information, native schema rejection including unsafe integers, and legacy global/extension config override behavior, but they still do not prove native permission decisions.

The final reviewer must approve or reject these external-boundary limitations explicitly; this report does not treat passing local tests as approval.

## Repository reference: `packages/fast`

`packages/fast` is useful precedent for the intended opt-in and scope semantics, although it deliberately does not persist state. `fast.ts:29-35` reinitializes from the explicit `PI_FAST` opt-in on `session_start`, and `fast.test.ts:95-106` verifies that a child session starts OFF after its parent enables FAST unless the child is explicitly opted in. Its README also clearly calls the mode “current session” state.

That comparison exposes an additional design decision for YOLO: the current `~/.pi/agent/yolo-state.json` is global to the agent directory, so every independent Pi session and subagent inherits the last toggle. If “persistent in a session” means preserve state across reload and compaction **within that session**, but do not silently opt new sessions/subagents into YOLO, the current global file has the wrong scope. A session-keyed durable state or a supported session/runtime API is needed. If global opt-in is intentional, the README and tests must say so explicitly and cover cross-session interference.

## Assumptions

- “OFF by default on a new install/session” means OFF when there is no prior explicit YOLO state. After an explicit toggle, persistence across later sessions/restarts takes precedence.
- “Explicit deny” is interpreted literally as every matching configured deny, including lower-precedence scopes. If it means only the final effective rule after normal permission precedence, the native rewrite preserves that narrower guarantee.
- If every independent conversation must start OFF, the global `~/.pi/agent/yolo-state.json` design is also too broad; state would need a session identity and explicit inheritance rules.

## Prioritized findings

### Blocker — Missing state can bootstrap YOLO as enabled

**Location:** `packages/yolo/yolo.ts:51-82`, especially `readPersistedYoloMode()`; regression test `packages/yolo/yolo.test.ts:123-129`.

**Evidence:** On `ENOENT`, the implementation reads native `yoloMode` and persists it:

```ts
let enabled = false;
try {
  enabled = readNativeYoloMode();
} catch (nativeError) {
  if (!isMissingFile(nativeError)) throw nativeError;
}
writePersistedYoloMode(enabled);
```

The test explicitly expects an absent state file plus native `true` to become enabled. This contradicts the README's unqualified “A missing state file defaults to OFF” claim at `packages/yolo/README.md:30`.

**Impact:** Installing `pi-yolo` into an environment whose native config already says `true` silently creates an enabled persistent state. There is no provenance distinguishing a prior explicit `/yolo` toggle from declarative configuration, manual editing, or an old unsafe default.

**Smallest safe fix:** Treat every missing state file as `false` and reconcile native YOLO to `false`. Do not infer consent from native configuration. If upgrade preservation is required, migrate only from evidence uniquely written by a prior `pi-yolo` version; otherwise document that upgrades require one explicit `/yolo on`.

---

### Blocker — Trusted project config can override the persisted/global state

**Location:** `packages/yolo/yolo.ts:14-18,112-127`; installed `@gotgenes/pi-permission-system` 25.1.0 `src/config-loader.ts:203-218,280-285,345-370` and `src/handlers/before-agent-start.ts:64-69`.

**Evidence:** `pi-yolo` edits only the global config. The permission system merges scalar `yoloMode` values with the trusted project's config taking highest precedence, and refreshes that merged configuration before agent start.

**Impact:**

- Persisted/global OFF plus trusted-project `yoloMode: true` produces effective YOLO ON while the `pi-yolo` status says OFF.
- Persisted/global ON plus trusted-project `yoloMode: false` produces effective YOLO OFF while the status says ON.
- A project configuration can therefore defeat both default-off and persistence semantics.

**Smallest safe fix:** Do not use a normal precedence-scoped config key as the toggle channel. Add a supported permission-system runtime override sourced from operator-owned state and applied after project configuration. Project configuration must not be allowed to enable that override. Writing every project config is not a safe alternative.

---

### High — Global persistence leaks YOLO into independent sessions and subagents

**Location:** `packages/yolo/yolo.ts:20,34-35,63-83`; comparison implementation `packages/fast/fast.ts:29-35` and `packages/fast/fast.test.ts:95-106`.

**Evidence:** YOLO stores one state at `getAgentDir()/yolo-state.json`, independent of the Pi session file. Every new extension instance reads that same value during `session_start`. In contrast, the repository's FAST implementation resets each session from an explicit environment opt-in and tests that a child session starts OFF after the parent enables FAST.

**Impact:** If the requested persistence is session-local, enabling YOLO in one conversation silently enables it in unrelated conversations and subagents. A later `/yolo off` in one session also changes the effective mode of other running sessions. This violates least-surprise isolation and can make a new session appear enabled even though it never received explicit consent.

**Smallest safe fix:** Define the scope first. For session-local persistence, key durable state by the Pi session identity (or use a supported session/runtime state API) and restore it on reload/compaction without sharing it with unrelated sessions. For intentionally global persistence, keep a global file but document that scope and add cross-session/subagent tests; do not describe it as “current session.”

---

### High — Malformed state can leave effective permissions in YOLO while displaying OFF

**Location:** `packages/yolo/yolo.ts:63-75,144-156`.

**Evidence:** Invalid state JSON or a non-boolean `enabled` value throws. `syncStatus()` catches the error, sets only its local `enabled = false`, and displays `YOLO: OFF`; it does not disable native YOLO or verify/reload the permission system.

**Impact:** If native config/cache is already enabled, a corrupt state file produces an OFF indicator while permission checks continue auto-approving asks. This is a dangerous fail-open status mismatch.

**Smallest safe fix:** Define a fail-closed corruption policy. On invalid state, disable effective YOLO through a supported live API before showing OFF. If disabling cannot be confirmed, display `ERROR/UNKNOWN`, block agent start, or force a verified permission-system reload. Preserve the corrupt file for diagnosis.

---

### High — State and native config are not updated atomically

**Location:** `packages/yolo/yolo.ts:86-136,194-215`; inaccurate documentation at `packages/yolo/README.md:39`.

**Evidence:** The command writes `yolo-state.json` first and the native config second. Each file is individually replaced, but there is no transaction or rollback across the two files. For example:

- A missing/unwritable permission config can leave `enabled: true` persisted even though the command reports failure.
- A crash or disk error after one rename leaves state and native values different.
- `ctx.reload()` is outside error handling. A reload rejection occurs after state, config, status, and notification have already changed.

**Impact:** A command can report an error while committing a security-relevant future state. A later lifecycle event can unexpectedly activate it, or a restart can follow a value different from the last successfully completed command.

**Smallest safe fix:** Use one authoritative persisted state owned by the permission system. If the two-file design is temporarily retained, add explicit reconciliation/rollback semantics, report whether the requested state committed, and catch reload failures separately. Remove the claim that both files are atomically updated.

---

### High — Concurrent read/modify/write can lose permission rules, including denies

**Location:** `packages/yolo/yolo.ts:88,114-127`; installed permission-system `src/config-store.ts:152-173`.

**Evidence:** Every process uses fixed temporary names (`yolo-state.json.tmp` and `config.json.tmp`). `setNativeYoloMode()` reads the complete config and later replaces it. There is no lock, unique temporary name, generation check, or retry. The permission system itself also uses `config.json.tmp`.

If another process or Home Manager writes a new deny after YOLO reads the old config but before YOLO renames its copy, YOLO can restore the stale document and erase the deny. Fixed temporary names can also cause one writer to rename or delete another writer's temporary file.

**Impact:** Parallel sessions/subagents and config management can corrupt state, make state/config diverge, or remove security policy.

**Smallest safe fix:** Centralize writes in the permission system. As an interim mitigation, use unique same-directory temporary files, a cross-process lock, re-read under the lock, and abort/retry on generation changes. External non-cooperating writers still prevent a true transaction, reinforcing the need for one owner.

---

### High — “Never bypass explicit deny” is true only for the final effective rule

**Location:** installed permission-system `src/permission-manager.ts:225-239,293-298`, `src/rule.ts:63-66,100-114`, and `src/config-loader.ts:203-218,280-285`.

**Evidence:** `rewriteAsksToYolo()` leaves rules whose current action is `deny` unchanged. That correctly preserves a final effective deny. However:

1. Project configuration has higher precedence and can replace a global deny with `ask`; YOLO then allows it.
2. An invalid higher-precedence scope is rejected wholesale, including otherwise valid deny entries. The permission system floors inherited allows to `ask`, after which YOLO rewrites those fail-closed asks back to `allow`.
3. The permission system uses last-match-wins, not deny-always-wins.

**Impact:** Under the literal requirement, an explicit deny can be bypassed through scope shadowing or malformed-scope handling even though the rewrite function itself does not mutate a `deny` action.

**Smallest safe fix:** Resolve the product ambiguity explicitly. If deny must be absolute, add an upstream deny-lock pass that considers every matching valid deny across scopes before applying YOLO. At minimum, YOLO must not re-permit `origin: "fail-closed"` asks. If only final effective denies are protected, document that limitation precisely.

---

### High — Valid permission-system JSONC is rejected by `pi-yolo`

**Location:** `packages/yolo/yolo.ts:51-55,117-123`; installed permission-system `src/config-loader.ts:26-66,420-432`.

**Evidence:** `pi-yolo` uses raw `JSON.parse`. The permission system strips comments before parsing and accepts JSONC-style config. Therefore a config accepted by the native extension can be rejected by `pi-yolo`.

The casts also allow `null`, arrays, and primitive roots through parsing. `null` causes property access failure; adding `yoloMode` to an array does not survive `JSON.stringify` as a normal property.

**Impact:** Supported native configuration formats can disable toggling or leave persisted/native values split. The UI state does not prove effective native state.

**Smallest safe fix:** Stop parsing another package's private file format. Use its public API. If temporarily unavoidable, share its parser/schema and reject non-object roots before committing state.

---

### Medium — Effective state depends on extension handler order and cache timing

**Location:** `packages/yolo/yolo.ts:159-171`; installed permission-system `src/handlers/before-agent-start.ts:64-69`; Pi 0.84.2 extension runner/loader.

**Evidence:** Pi awaits extension handlers sequentially in discovery order. The permission system refreshes cached runtime config in `before_agent_start`; YOLO also writes the file in that event. If the permission system runs first, it can cache the old value for the imminent turn and YOLO writes only afterward. The native manager reads the cached config per check, not the file directly.

Normal user input often gives YOLO an earlier `input` event, but extension-triggered turns and external rewrites need not.

**Impact:** Persisted OFF can remain effectively ON for a turn, or persisted ON can still prompt, depending on ordering and event path.

**Smallest safe fix:** Use a supported live setter or event handshake rather than file mutation. Add integration tests with both load orders and turns that do not originate from `input`.

---

### Medium — Multiple state owners produce stale and contradictory UI

**Location:** `packages/yolo/yolo.ts:140-156,159-171`; installed permission-system `src/config-modal.ts:94-151` and `src/status.ts:19-31`.

**Evidence:** `/permission-system` can edit `yoloMode` independently, while `/yolo` treats `yolo-state.json` as authoritative and overwrites native changes on lifecycle events. Both extensions publish separate YOLO-related status entries.

**Impact:** Native command changes can be transient, and status indicators can disagree—especially after corruption, project overrides, or partial failures.

**Smallest safe fix:** Establish one owner and one status source. Make `/yolo` a thin alias for the native supported setter.

---

### Medium — Compatibility and type safety are effectively unchecked

**Location:** `packages/yolo/yolo.ts:1`; `packages/yolo/package.json:29-31`; root `package.json:16,22`.

**Evidence:** The entire implementation is under `@ts-nocheck` despite Pi types being installed. The peer range is `"*"`, and there is no peer/optional dependency on `@gotgenes/pi-permission-system`, even though this package depends on its private path, schema, cache behavior, and YOLO semantics.

**Impact:** `npm run typecheck` provides no meaningful type assurance for the main file. Older or future Pi/permission-system versions can install successfully and fail at runtime.

**Smallest safe fix:** Remove `@ts-nocheck`, type handlers and contexts, bound the Pi peer range to tested APIs, and declare a compatible optional peer for permission-system with install-time guidance.

---

### Medium — Home Manager and filesystem replacement behavior is unsafe or misleading

**Location:** `packages/yolo/yolo.ts:112-127`; `packages/yolo/README.md:47-49`.

**Evidence:** Replacing `config.json` with `renameSync` can replace a managed symlink with a new regular file and can lose the target file's mode, ACLs, ownership metadata, and formatting. On some platforms, rename-over-existing differs or fails.

**Impact:** The extension can break declarative ownership or continually fight configuration rewrites. The README presents this as supported without documenting these constraints.

**Smallest safe fix:** Do not mutate declaratively managed configuration. Store runtime state separately and have the permission system consume it through a supported override.

---

### Low — Tests validate file preservation, not permission behavior

**Location:** `packages/yolo/yolo.test.ts:18-132`.

**Evidence:** The single test:

- expects the unsafe native-true migration;
- checks that the string `"deny"` remains in JSON but never runs a permission decision;
- mocks reload rather than loading Pi and the permission system;
- does not exercise malformed files, missing config, failures, concurrency, project precedence, handler order, JSONC, or reload rejection;
- includes unused session-history and `appendEntry` scaffolding that does not affect production code.

**Impact:** The test can pass while all blocker/high findings remain.

**Smallest safe fix:** Split unit cases and add a pinned two-extension integration suite exercising real permission decisions.

---

### Low — Documentation contains contradictory or inaccurate claims

**Location:** `packages/yolo/README.md:19,30-49`.

**Evidence:**

- `/yolo` is described as toggling “the current session,” but state is global and persistent.
- Missing state “defaults to OFF,” followed by an exception that imports native true.
- Updating both files is called atomic.
- “Explicit deny rules are never changed” omits scope shadowing, malformed config, and concurrent lost-update risks.
- Home Manager compatibility omits symlink/rewrite races.

**Smallest safe fix:** Correct these claims after semantics are fixed; document state scope, authority, corruption policy, supported versions, and the effective-deny interpretation.

---

### Low — Release coverage does not assert the YOLO release mapping

**Location:** `test/release.test.ts:25-41`.

**Evidence:** `scripts/resolve-release.mjs` includes YOLO and refs for `pi-yolo-0.1.1`/`pi-yolo-0.1.2` exist, but the positive release test only checks fast and lazy-skill-tool. The manifest and installed package are both 0.1.2.

**Smallest safe fix:** Assert `pi-yolo-${manifest.version}` resolves to `packages/yolo`, and validate the tagged tarball in release CI.

## Requirement-by-requirement assessment

| Requirement | Assessment | Evidence |
| --- | --- | --- |
| OFF by default without prior consent | **Not satisfied** | Missing state imports native true; trusted project config can also enable effective YOLO. |
| Enabled YOLO bypasses ask/prompts | **Satisfied only on valid, synchronized permission-system 25.1.0 happy path** | Native `rewriteAsksToYolo()` maps ask to allow and the gate runner auto-approves the resulting YOLO grant. |
| Never bypass explicit deny | **Partial / ambiguity-dependent** | Final effective deny is preserved; shadowed denies and fail-closed asks are not absolute. |
| Preserve ON/OFF through reload/restart/compaction | **Partial** | Separate file survives normal lifecycle events, but races, partial failures, project overrides, and corruption break effective-state continuity. |
| Preserve state active before lifecycle event | **Not guaranteed** | Multiple global sessions share one file, external writers race, and unsuccessful commands can still persist a future value. |

## Missing and regression tests

Required before release:

1. Missing state with native `true` must initialize OFF.
2. Missing state and missing native config/directory.
3. Malformed JSON, wrong-shaped state, and invalid/missing `enabled`, with native true.
4. Valid permission-system JSONC and malformed/non-object native config.
5. Real permission checks: `ask` becomes `allow`; effective deny blocks bash, path, external-directory, and forwarded-subagent paths.
6. Global deny plus project ask/true/false overrides under trusted and untrusted projects.
7. Malformed higher-precedence scope while YOLO is enabled.
8. Actual Pi lifecycle: startup, resume, new, fork, reload, restart, manual/automatic compaction, and turns without an `input` event.
9. Parent enables YOLO, then a new independent session/subagent must follow the explicitly chosen scope (session-local OFF or intentionally global ON).
10. Both extension load orders.
11. Concurrent sessions toggling opposite values and concurrent config rule rewrites.
12. Injected failures for read, state write, config write, each rename, cleanup, and reload rejection.
13. Native `/permission-system` changes while `pi-yolo` is installed.
14. Home Manager-like rewrites, managed symlink, read-only directory, and Windows replacement behavior.
15. Pinned compatibility matrix and packaged-tarball smoke test.
16. Positive `pi-yolo` release-tag resolution.

## Correct observations

- Installed permission-system 25.1.0 defaults native YOLO to false when no valid setting exists (`src/extension-config.ts:35-38`).
- Its direct rewrite leaves final effective deny rules unchanged (`src/rule.ts:63-66`).
- State is independent of session transcript entries, so normal compaction does not erase the separate state file.
- Root scripts include the YOLO test and workspace pack check.
- Package metadata includes source, README, license, and the expected Pi extension entry point.
- The installed `@valdo766hi/pi-yolo` 0.1.2 source is the pre-fix published implementation; it does not include the current working-tree changes.

## History and validation notes

Git history shows the behavior was introduced through:

- `2a385f5` — `fix(pi-yolo): persist native yolo mode across sessions`
- `4188293` — `fix(pi-yolo): persist last explicit toggle state`

The second change added the separate state file but also added the unsafe “missing state → native setting” migration. The current branch is `4188293` (`pi-yolo-0.1.2`); the working-tree hardening is now versioned as `pi-yolo-0.1.3`.

Parent-side read-only validation for this review:

- `npm test` — **passed**, 49 tests.
- `npm run typecheck` — **passed**.
- `npm run pack:check` — **passed** for all workspaces.
- LSP diagnostics — **clean** for changed TypeScript files.
- `git diff --check` — **passed**.
- Initial `git status --short --branch` was clean before the review artifact was created.

The fresh-context reviewers did not run shell commands; their findings were based on source inspection and installed permission-system source. Runtime integration, concurrency, and actual extension load-order behavior remain unverified.

## Recommended implementation order

1. Decide and document whether YOLO persistence is session-local or intentionally global; use the session-local model from `packages/fast` unless global sharing is explicitly required.
2. Remove native-config migration on missing state; initialize OFF and add a regression test.
3. Add a supported runtime override/setter to the permission system; stop editing its private config from `pi-yolo`.
4. Define deny semantics explicitly and enforce deny-always-wins (or document the narrower final-effective-rule guarantee).
5. Make corrupted/unknown state fail closed and expose an `ERROR/UNKNOWN` status when effective state cannot be confirmed.
6. Add real integration tests for permission decisions and Pi lifecycle/load-order/scope behavior.
7. Update README/package compatibility metadata and add the missing release mapping assertion.

## Deferred or optional improvements

- Add a schema/version field to persisted state for future migrations.
- Use one status entry with `ON`, `OFF`, and `ERROR/UNKNOWN`.
- Avoid synchronous disk reads on every input and lifecycle event after a supported live state owner exists.
- Record audited toggle provenance and timestamp without storing it in conversation history.
- Clarify whether global sessions/subagents intentionally share one toggle.

## Final review disposition

The earlier strict-contract review was **NOT APPROVED** because several guarantees require changes outside this repository. After the latest local-only fixes, the fresh reviewer verdict is **APPROVED for the local-only scope**: no actionable defects remain in `pi-yolo`.

Resolved locally:

- Missing state no longer imports native consent and now defaults OFF.
- Session-keyed state survives same-session lifecycle events.
- JSONC parsing, version-aware defensive native schema validation (including safe integer bounds and 25.3+ prompt-field compatibility), typing, package metadata, release mapping, rollback handling, and local test coverage were improved.
- Unknown/conflicting state now reports `YOLO: ERROR`, handles input conservatively, blocks and terminates unsafe tool calls, and requests aborts at before-agent, agent-start, and turn boundaries.
- Missing trust information fails closed; legacy global and extension configurations are detected and overridden off before a session can opt in; native writes use unique temps, optimistic checks, and post-write verification.

Documented external residuals, not local approval blockers:

- The permission system exposes only a global native `yoloMode`; session-keyed files cannot prevent concurrent sessions from overwriting each other's effective mode.
- Trusted and legacy project config still has native precedence; the extension can detect conflicts and fail safe but cannot provide an operator-owned session-scoped override.
- Native YOLO can re-permit fail-closed asks and does not guarantee literal deny-always-wins semantics across scopes.
- Direct config replacement still has a cross-process TOCTOU window; a shared permission-system transaction is required.
- No portable real Pi plus permission-system integration suite exists in this repository.
- `ctx.abort()` cannot cancel every not-yet-started or extension-triggered agent run; the local guards are best-effort safeguards.

Therefore the **local implementation task is approved and good**, while the original strict session-isolation/literal-deny contract remains impossible to guarantee without upstream API/behavior changes or an explicit requirement relaxation.
