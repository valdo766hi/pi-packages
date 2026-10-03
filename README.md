# Pi packages

Small public Pi extensions published under the `@valdo766hi` npm scope.

## Packages

| Package | Purpose | Install |
| --- | --- | --- |
| [`@valdo766hi/pi-fast`](packages/fast) | Toggle OpenAI priority requests with `/fast` | `pi install npm:@valdo766hi/pi-fast` |
| [`@valdo766hi/pi-footer`](packages/footer) | Calm two-line footer for context, usage, model, and active modes | `pi install npm:@valdo766hi/pi-footer` |
| [`@valdo766hi/pi-yolo`](packages/yolo) | Session-local permission approval overlay with `/yolo` | `pi install npm:@valdo766hi/pi-yolo` |
| [`@valdo766hi/pi-lazy-skill-tool`](packages/lazy-skill-tool) | Replace Pi's verbose skill catalog with lazy exact-name loading | `pi install npm:@valdo766hi/pi-lazy-skill-tool` |

## Development

Use Node.js 24 or newer.

```sh
npm ci --ignore-scripts
npm run check
```

`npm run check` type-checks source, discovers all tests, runs lazy-skill benchmark
gates, and verifies every workspace tarball. Keep source, tests, changelogs,
documentation, and metadata together under `packages/<name>`.

Development uses Pi 1.0.0 and TypeBox 1.3.34. Compatibility checks cover Pi
0.85.1 / permission-system 32.1.0 and Pi 1.0.0 / permission-system 39.0.2 on
Node.js 22.19 and 24. Permission-system is a development-only UI contract fixture;
consumers install it separately if using YOLO.

**Dependency advisory:** Pi 1.0.0's published shrinkwrap installs
`brace-expansion@5.0.9`, which has a high-severity DoS advisory (fixed in 5.0.12).
`npm audit fix` and overrides do not replace that shrinkwrapped dependency here.
These extensions do not bundle it, but their Pi host does; recheck `npm audit`
and the installed dependency version before publishing. No security fix is
claimed until upstream updates its package.

## Releases

Packages are versioned and released independently. The release tag must match
the package name and version exactly:

```text
pi-fast-x.x.x
pi-footer-x.x.x
pi-yolo-x.x.x
pi-lazy-skill-tool-x.x.x
```

Prepared patch versions (not yet published):

| Workspace | Version | Release tag |
| --- | --- | --- |
| `fast` | `0.1.3` | `pi-fast-0.1.3` |
| `footer` | `0.2.1` | `pi-footer-0.2.1` |
| `yolo` | `0.1.7` | `pi-yolo-0.1.7` |
| `lazy-skill-tool` | `0.3.1` | `pi-lazy-skill-tool-0.3.1` |

For subsequent releases, bump the chosen workspace with
`npm version --workspace=packages/<name> --no-git-tag-version <next-version>`
and add its changelog entry. Commit the reviewed changes before tagging. For
the prepared lazy-skill release, validate and push its matching tag:

```sh
npm run check
node scripts/resolve-release.mjs pi-lazy-skill-tool-0.3.1
git tag -a pi-lazy-skill-tool-0.3.1 -m "release: pi-lazy-skill-tool 0.3.1"
git push origin main
git push origin refs/tags/pi-lazy-skill-tool-0.3.1
```

Use the corresponding workspace and tag for `fast`, `footer`, or `yolo`. The
publish workflow validates the tag, publishes only the matching public package
with npm trusted publishing and provenance, and creates the matching GitHub
Release with generated notes. Push release tags one at a time: GitHub does not
emit tag push events when more than three tags are pushed together.

To recover a missed trigger, run Publish manually against an existing tag:

```sh
gh workflow run publish.yml --ref main -f tag=pi-lazy-skill-tool-0.3.1
```

The manual run checks out that tag, validates its package/version, and runs the
same checks and trusted publishing steps. It does not move or recreate tags.

## License

Apache License 2.0. See [`LICENSE`](LICENSE).
