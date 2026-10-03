# Pi footer

A calm two-line Pi footer: where you are and what is thinking, then how full the
context is, what the session used, and which modes are on.

```text
nix · ⎇ main                                        gpt-6-luna ● max
━━━━━━━━━╸──────────│──  42%  108k/258k      ↑1.2M ↓84k  ◎ 91%  ⚡ fast  ⚠ yolo
```

Install it with:

```sh
pi install npm:@valdo766hi/pi-footer
```

[View this package on npm](https://www.npmjs.com/package/@valdo766hi/pi-footer)

- **Line 1:** project folder, Git branch, session name, then the model and its
  thinking level.
- **Line 2:** context bar and percentage (green, yellow above 70%, red above
  90%), with `│` marking the configured auto-compaction threshold; then session
  input and output tokens, last-turn cache hit rate, cost above zero, and status
  chips from other extensions.
- `FAST` and `YOLO` statuses appear as chips only while on; any `…: OFF` status is
  hidden. Other extension statuses follow, unchanged.
- Narrow terminals drop detail in this order: cost, cache, tokens, chip labels,
  then the bar. The footer never grows past two lines.

Colors come from the active Pi theme. The footer needs no Nerd Font.

Use `/footer` to toggle between this footer and Pi's built-in one.

The marker uses global and trusted-project compaction settings, including
model overrides when supported by Pi. Settings refresh at installation and
before each turn, without writes. Disabled compaction or unreadable settings
hide the marker. Project labels support POSIX, Windows drive, and UNC paths.

Validated with Pi 0.85.1 and 1.0.0 on Node.js 22.19+.
See [CHANGELOG.md](./CHANGELOG.md) for release notes.
