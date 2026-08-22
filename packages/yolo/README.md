# Pi YOLO extension

Install it with:

```sh
pi install npm:@valdo766hi/pi-yolo
```

[View this package on npm](https://www.npmjs.com/package/@valdo766hi/pi-yolo)

This extension registers `/yolo` and adds a session-local approval overlay for
`@gotgenes/pi-permission-system`. Install that permission-system extension
separately before using YOLO.

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
`packages/fast`.

## Permission behavior

When enabled, YOLO listens for the permission system's public
`permissions:ui_prompt` event and automatically selects approval for that
permission prompt. The native permission system evaluates its rules first:
final `deny` decisions do not open a prompt and are therefore not auto-approved.
The permission-system configuration and its permission map are never written or
replaced by this package.

The overlay supports both Pi's selector-based UI and TUI custom permission
dialog. The public event exposes facts but no request-correlated UI callback, so
the extension uses a short-lived process-local arm and wraps the next matching
Pi UI method. This is a best-effort integration coupled to the permission
system's prompt labels and result shape. Ordinary UI dialogs remain untouched
while YOLO is off. If the native permission-system extension is not loaded,
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
