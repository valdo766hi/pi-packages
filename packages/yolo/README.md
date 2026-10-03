# Pi YOLO extension

Install it with:

```sh
pi install npm:@valdo766hi/pi-yolo
```

[View this package on npm](https://www.npmjs.com/package/@valdo766hi/pi-yolo)

This extension registers `/yolo` and adds a session-local approval overlay for
`@gotgenes/pi-permission-system`. Install that permission-system extension
separately before using YOLO.

Validated pairs: Pi 0.85.1 with permission-system 32.1.0, and Pi 1.0.0 with
permission-system 39.0.2, on Node.js 22.19+. Versions 33–38 are not claimed as
compatible. See [CHANGELOG.md](./CHANGELOG.md) for release notes.

## Commands

```text
/yolo       # toggle this session
/yolo on    # enable for this session
/yolo off   # disable for this session
```

YOLO is **OFF by default**. An explicit toggle is persisted in a
session-keyed file:

```text
~/.pi/agent/yolo-state/<session-id>.json
```

`PI_CODING_AGENT_DIR` is honored. The same session restores its state after a
restart, reload, resume, or compaction. A new session, fork, or subagent starts
OFF unless explicitly enabled there, matching the opt-in behavior of
`packages/fast`. Toggling does not reload Pi or reset other extensions' modes.

## Permission behavior

When enabled, YOLO listens for the permission system's public
`permissions:ui_prompt` event and automatically selects approval for that
permission prompt. The native permission system evaluates its rules first:
final `deny` decisions do not open a prompt and are therefore not auto-approved.
The permission-system configuration and its permission map are never written or
replaced by this package.

The overlay supports both Pi's selector-based UI and TUI custom permission
dialog. The public event exposes facts but no request-correlated UI callback, so
the extension arms only the synchronous UI call immediately after a valid
request event and expires the arm at the next microtask. Malformed events and
overlapping request IDs cannot arm approval; decision events clear only their
matching request. Selector headings must match the native permission dialog.
This is a best-effort integration coupled to the permission system's prompt
labels and result shape. Ordinary UI dialogs remain untouched
while YOLO is off. Even while enabled, unrelated selectors are delegated.
Custom inline dialogs expose no request identity: another extension opening an
inline dialog synchronously from that same event remains an integration limit.
If the native permission-system extension is not loaded,
YOLO state can still be persisted but there is no permission prompt to
intercept.

Keep the native permission-system `yoloMode` setting disabled. If it is enabled
by another configuration source, that native global mode remains independent of
this session-local overlay. Concurrent sessions can still share the native
permission system, but their `pi-yolo` overlay state is stored separately.

A corrupt state file is reported as `YOLO: ERROR` rather than silently claiming
that permissions are OFF. Input is handled, unsafe tool calls are blocked and
terminated, and agent/turn boundaries request an abort. Pi does not expose a
universal cancellation hook for every extension-triggered turn, so these are
fail-closed best-effort safeguards rather than a replacement for the native
permission gate. Fix or remove the corrupt state file before toggling again.

This package contains only the command and runtime overlay. Personal permission
rules and Home Manager configuration are not included in the npm tarball.
