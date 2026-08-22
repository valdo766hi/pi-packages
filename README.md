# Pi packages

Small public Pi extensions published under the `@valdo766hi` npm scope.

## Packages

| Package | Purpose | Install |
| --- | --- | --- |
| [`@valdo766hi/pi-fast`](packages/fast) | Toggle OpenAI priority requests with `/fast` | `pi install npm:@valdo766hi/pi-fast` |
| [`@valdo766hi/pi-footer`](packages/footer) | Show context, token, cache, cost, and model details | `pi install npm:@valdo766hi/pi-footer` |
| [`@valdo766hi/pi-yolo`](packages/yolo) | Toggle native permission-system YOLO mode with `/yolo` | `pi install npm:@valdo766hi/pi-yolo` |
| [`@valdo766hi/pi-lazy-skill-tool`](packages/lazy-skill-tool) | Replace Pi's verbose skill catalog with lazy exact-name loading | `pi install npm:@valdo766hi/pi-lazy-skill-tool` |

## Development

Use Node.js 24 or newer.

```sh
npm ci
npm run check
npm run benchmark:lazy-skills
```

`npm run check` runs the test suite and verifies every workspace tarball. Keep
package source, tests, documentation, and package metadata together under
`packages/<name>`.

## Releases

Packages are versioned and released independently. The release tag must match
the package name and version exactly:

```text
pi-fast-x.x.x
pi-footer-x.x.x
pi-yolo-x.x.x
pi-lazy-skill-tool-x.x.x
```

For a new release, update one workspace, validate it, then push its matching
tag:

```sh
npm version --workspace=packages/lazy-skill-tool --no-git-tag-version 0.1.1
npm run check
git tag -a pi-lazy-skill-tool-0.1.1 -m "release: pi-lazy-skill-tool 0.1.1"
git push origin main --follow-tags
```

Use the corresponding workspace and tag for `fast`, `footer`, or `yolo`. The
publish workflow validates the tag, publishes only the matching public package
with npm trusted publishing and provenance, and creates the matching GitHub
Release with generated notes.

## License

Apache License 2.0. See [`LICENSE`](LICENSE).
