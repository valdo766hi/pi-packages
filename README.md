# Pi packages

Small public Pi extensions published under the `@valdo766hi` npm scope.

## Packages

| Package | Purpose | Install |
| --- | --- | --- |
| [`@valdo766hi/pi-fast`](packages/fast) | Toggle OpenAI priority requests with `/fast` | `pi install npm:@valdo766hi/pi-fast` |
| [`@valdo766hi/pi-footer`](packages/footer) | Show context, token, cache, cost, and model details | `pi install npm:@valdo766hi/pi-footer` |
| [`@valdo766hi/pi-yolo`](packages/yolo) | Toggle native permission-system YOLO mode with `/yolo` | `pi install npm:@valdo766hi/pi-yolo` |

## Development

Use Node.js 24 or newer.

```sh
npm ci
npm test
npm run pack:check
npm run check
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
```

For a new release, update one workspace, validate it, then push its matching
tag:

```sh
npm version --workspace=packages/fast --no-git-tag-version 0.1.1
npm run check
git tag pi-fast-0.1.1
git push origin main --follow-tags
```

Use the corresponding workspace and tag for `footer` or `yolo`. The publish
workflow validates the tag and publishes only the matching public package with
npm trusted publishing and provenance.

## License

Apache License 2.0. See [`LICENSE`](LICENSE).
