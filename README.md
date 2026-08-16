# Centralized Pi packages

Small Pi packages maintained by `valdo766hi`, published under the
`@valdo766hi` npm scope.

## Packages

| Package | Purpose | Install |
| --- | --- | --- |
| [`@valdo766hi/pi-fast`](packages/fast) | Toggle OpenAI priority service-tier requests with `/fast` | `pi install npm:@valdo766hi/pi-fast` |
| [`@valdo766hi/pi-footer`](packages/footer) | Context, token, cache, cost, and model footer with `/footer` | `pi install npm:@valdo766hi/pi-footer` |
| [`@valdo766hi/pi-yolo`](packages/yolo) | Toggle the native permission-system YOLO setting with `/yolo` | `pi install npm:@valdo766hi/pi-yolo` |

`rtk`, the Catppuccin theme, the maintenance scripts, and the Home Manager
wiring remain in the original Nix repository and are intentionally not copied
here.

## Development

This repository uses the official devenv flake template and Node.js 24:

```sh
nix develop
npm install
npm test
npm run pack:check
nix flake check --impure
# or run the complete devenv test lifecycle:
devenv test
```

`npm run pack:check` performs a dry-run pack for every workspace. The explicit
`files` lists in each package manifest keep tests, repository configuration, and
personal configuration out of published tarballs.

## Package prerequisites

Pi supplies the `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`
modules at runtime; the packages declare them as peer dependencies and do not
bundle them.

`pi-yolo` is only the command extension. It requires the separately installed
`@gotgenes/pi-permission-system` extension and never publishes the personal
permission policy from Home Manager.

## Releases

Each package is released independently. The Git tag must exactly match the
unscoped package name and manifest version:

```text
pi-fast-x.x.x
pi-footer-x.x.x
pi-yolo-x.x.x
```

For example, `@valdo766hi/pi-fast` at version `0.1.1` is released by pushing
`pi-fast-0.1.1`. The publish workflow rejects unknown tags and version/tag
mismatches, runs validation, then publishes only the matching workspace to npm
using GitHub Actions OIDC trusted publishing with provenance.

### Initial npm setup

The initial `0.1.0` versions are not published automatically by this
repository. Publish each package once locally after reviewing its tarball:

```sh
npm whoami
npm pack --dry-run --workspace=packages/fast
npm publish --workspace=packages/fast --access public
npm publish --workspace=packages/footer --access public
npm publish --workspace=packages/yolo --access public
```

Then configure an npm trusted publisher for each public package, using:

- GitHub owner: `valdo766hi`
- Repository: `pi-packages`
- Workflow: `.github/workflows/publish.yml`

Do not create or push a release tag for `0.1.0` unless you intentionally want
the automated workflow to publish that already-published version. For a later
release, update one workspace version without creating npm's default tag, run
the checks, and push the matching tag:

```sh
npm version --workspace=packages/fast --no-git-tag-version 0.1.1
git tag pi-fast-0.1.1
git push origin main --follow-tags
```

Use the corresponding workspace and tag for `footer` or `yolo`. Tag creation,
Git pushes, and npm publication are deliberately not performed by local
validation.

## License

Apache License 2.0. See [`LICENSE`](LICENSE).
