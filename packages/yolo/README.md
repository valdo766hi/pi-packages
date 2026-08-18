# Pi YOLO extension

Install it with:

```sh
pi install npm:@valdo766hi/pi-yolo
```

[View this package on npm](https://www.npmjs.com/package/@valdo766hi/pi-yolo)

This extension registers `/yolo` and keeps the user's last YOLO toggle
persistent while synchronizing `@gotgenes/pi-permission-system`'s native
`yoloMode` setting. Install that permission-system extension separately before
using this package.

## Commands

```text
/yolo       # toggle the current session
/yolo on    # enable
/yolo off   # disable
```

The persistent state is stored at:

```text
~/.pi/agent/yolo-state.json
```

`PI_CODING_AGENT_DIR` is honored. A missing state file defaults to OFF. After
`/yolo on` or `/yolo off`, the last explicit toggle is restored across fresh
sessions, subagents, compaction, reload, and restart. Older `yolo-state`
session entries are ignored. If the state file is missing during an upgrade,
the existing native setting is migrated once.

## Permission behavior

Native YOLO changes only `ask` decisions to `allow`. Explicit `deny` rules are
never changed. The command atomically updates both the persistent state and the native
permission-system config at:

```text
~/.pi/agent/extensions/pi-permission-system/config.json
```

After changing the setting, the extension reloads Pi so the permission system
sees the new value immediately. Home Manager may keep `yoloMode` declared as
`false`; the extension restores the user's last explicit toggle from
`yolo-state.json`, so Home Manager does not need to declare `true`.

This package contains only the command extension. Personal permission rules and
Home Manager configuration are not included in the npm tarball.
