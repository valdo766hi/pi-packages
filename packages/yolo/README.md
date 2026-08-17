# Pi YOLO extension

Install it with:

```sh
pi install npm:@valdo766hi/pi-yolo
```

[View this package on npm](https://www.npmjs.com/package/@valdo766hi/pi-yolo)

This extension registers `/yolo` and keeps the session's YOLO state in sync
with `@gotgenes/pi-permission-system`'s native `yoloMode` setting. Install that
permission-system extension separately before using this package.

## Commands

```text
/yolo       # toggle the current session
/yolo on    # enable
/yolo off   # disable
```

The state is stored in the Pi session as `yolo-state`. A fresh session starts
off; resuming or reloading a session reapplies its stored state.

## Permission behavior

Native YOLO changes only `ask` decisions to `allow`. Explicit `deny` rules are
never changed. The command updates the permission-system config atomically at:

```text
~/.pi/agent/extensions/pi-permission-system/config.json
```

`PI_CODING_AGENT_DIR` is honored by Pi. After changing the setting, the
extension reloads Pi so the permission system sees the new value immediately.
Home Manager may restore a Nix-declared config during a later activation, so
restart Pi after activation and toggle YOLO again if needed.

This package contains only the command extension. Personal permission rules and
Home Manager configuration are not included in the npm tarball.
