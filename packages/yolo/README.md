# Pi YOLO extension

Install it with:

```sh
pi install npm:@valdo766hi/pi-yolo
```

[View this package on npm](https://www.npmjs.com/package/@valdo766hi/pi-yolo)

This extension registers `/yolo` and synchronizes the native
`@gotgenes/pi-permission-system` YOLO setting. Install that permission-system
extension separately before enabling YOLO.

## Commands

```text
/yolo       # toggle this session
/yolo on    # enable for this session
/yolo off   # disable for this session
```

YOLO is **OFF by default**. The extension never imports an existing native
`yoloMode: true` value as consent. An explicit toggle is persisted in a
session-keyed file:

```text
~/.pi/agent/yolo-state/<session-id>.json
```

`PI_CODING_AGENT_DIR` is honored. The same session restores its state after a
restart, reload, resume, or compaction. A new session, fork, or subagent starts
OFF unless explicitly enabled there, matching the opt-in behavior of
`packages/fast`.

## Permission behavior

When enabled, the native permission system changes `ask` decisions to `allow`.
The permission map is not rewritten, and the native system keeps final
`deny` decisions unchanged. YOLO does not grant permission to a rule that is
already an effective deny.

The native config is read as JSON or JSONC. Only its top-level `yoloMode` field
is changed; permission rules are preserved. Legacy global and legacy extension
configs are detected, and a higher-precedence new config override is written
when needed. Config updates use unique same-directory temporary files,
optimistic checks, a post-write verification, and reject symlink replacement.
Native schema fields introduced by newer compatible permission-system versions
are accepted only when that installed version is detected; unsupported or
invalid config is reported as an error. State and
native-config updates are separate atomic file operations with rollback on a
failed state write; they are not a cross-file transaction.

The native permission system's `yoloMode` is a global runtime setting. Do not
run multiple independent sessions concurrently against the same agent
configuration when they need different effective YOLO modes; a supported
session-scoped permission-system API is required for that stronger isolation.

A corrupt state, native config, or unverifiable project-trust state is reported
as `YOLO: ERROR` rather than silently claiming that permissions are OFF. Input
is handled, unsafe tool calls are blocked and terminated, and agent/turn
boundaries request an abort. Pi does not expose a universal cancellation hook
for every extension-triggered turn, so these are fail-closed best-effort
safeguards rather than a replacement for the native permission gate. Fix or
remove the corrupt state file before toggling again.

This package contains only the command extension. Personal permission rules and
Home Manager configuration are not included in the npm tarball.
