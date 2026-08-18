# Pi YOLO extension

Install it with:

```sh
pi install npm:@valdo766hi/pi-yolo
```

[View this package on npm](https://www.npmjs.com/package/@valdo766hi/pi-yolo)

This extension registers `/yolo` and keeps the global
`@gotgenes/pi-permission-system` native `yoloMode` setting in sync. Install that
permission-system extension separately before using this package.

## Commands

```text
/yolo       # toggle the current session
/yolo on    # enable
/yolo off   # disable
```

The permission-system config is the single persistent source of truth. A fresh
session, subagent, compaction, or reload reads the existing native setting and
never resets it from session history. Older `yolo-state` session entries are
ignored.

## Permission behavior

Native YOLO changes only `ask` decisions to `allow`. Explicit `deny` rules are
never changed. The command updates the permission-system config atomically at:

```text
~/.pi/agent/extensions/pi-permission-system/config.json
```

`PI_CODING_AGENT_DIR` is honored by Pi. After changing the setting, the
extension reloads Pi so the permission system sees the new value immediately.
If Home Manager manages this file, declare the desired `yoloMode` there as
`true`; otherwise a later activation can restore `false` and prompts will
correctly return.

This package contains only the command extension. Personal permission rules and
Home Manager configuration are not included in the npm tarball.
