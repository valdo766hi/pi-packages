# Centralized Pi Packages Migration Plan

## Context

Migrate the custom Pi resources currently managed under
`/Users/rivaldo/.config/nix/home-manager/common/pi` into this repository so each
publishable Pi package has one source of truth. The repository will use the
Cachix devenv flake template for development and validation. Releases will use
per-package Git tags in the form `<package-name>-x.x.x` and npm publication.

Current repository state: only `README.md` is tracked. The source tree is clean
for the relevant paths and contains the three extensions selected for migration
(`fast`, `footer`, and `yolo`), plus `rtk`, `catppuccin-mocha`, maintenance
scripts, Nix checks, Home Manager wiring, and subagent configuration that remain
in the existing Nix repository. There are no existing npm manifests or package
name conflicts in npm.

## Approach

- Use an npm-workspaces monorepo with three independently installable packages:
  `@valdo766hi/pi-fast`, `@valdo766hi/pi-footer`, and
  `@valdo766hi/pi-yolo`, initially versioned `0.1.0`. Each package will
  explicitly declare its Pi resources and published files in `package.json`.
- Do not copy or publish `rtk`, `catppuccin-mocha`, subagent configuration, or
  maintenance scripts; they remain managed by the existing Nix repository.
- Initialize the root by running the requested
  `nix flake init --template github:cachix/devenv`, preserve its generated
  baseline, and minimally enable Node.js 24 plus the repository checks.
- Preserve existing behavior while copying resources; avoid speculative shared
  tooling or abstractions. Do not edit or remove anything in the old Home
  Manager repository during this implementation.
- Publish automatically from GitHub Actions when a valid per-package tag is
  pushed. Prefer npm trusted publishing (OIDC, no long-lived write token) with
  public scoped packages and automatic provenance. Use Apache-2.0 for the
  repository and all three packages.

## Files to modify

- Template/devenv root files: `flake.nix`, `flake.lock`, `.envrc`,
  `.gitignore`, `devenv.nix`, and `devenv.lock` (the installed devenv CLI does
  not require a `devenv.yaml` for this local module).
- `package.json`, `package-lock.json` — private npm-workspace root and locked
  development dependencies.
- `README.md` — repository layout, development, installation, and release docs.
- `packages/fast/` — extension, existing test, README, npm manifest, and
  package-local license copy.
- `packages/footer/` — extension, README, npm manifest, and package-local
  license copy.
- `packages/yolo/` — extension, migrated test coverage, README, npm manifest,
  and package-local license copy; personal permission policy remains in Home
  Manager.
- `LICENSE` — Apache License 2.0 text.
- `.github/workflows/ci.yml` — install and run the same checks as devenv.
- `.github/workflows/publish.yml` — validate a package/version tag and publish
  exactly the matching workspace to npm.
- `scripts/resolve-release.mjs`, `test/`, and package-local tests — release-tag
  resolution, import smoke checks, and migrated extension behavior checks.

## Reuse

- Existing `fast`, `footer`, and `yolo` implementations under
  `/Users/rivaldo/.config/nix/home-manager/common/pi` will be copied without
  behavioral rewrites. Reuse `fast/fast.test.ts` and extract only the existing
  YOLO cases from shared `pi.test.ts`; unrelated script and RTK tests stay in
  the Nix repository.
- Existing Nix checks (`check.nix`, `extensions/fast/check.nix`) provide the
  behavioral baseline; the new repository uses `devenv test`/`enterTest` to run
  its root npm validation command instead of copying the old Nix stubs.
- Node's built-in test runner already executes the TypeScript tests under Node
  24, so no test framework or build step is needed.
- npm workspaces, package `files`, `publishConfig.access = "public"`, and
  `npm pack --dry-run` cover monorepo installation and tarball control without a
  release framework.
- The `yolo` package remains an add-on for separately installed
  `@gotgenes/pi-permission-system`; it updates that extension's documented
  global config path and must not publish the personal permission policy.
- Pi's native package manifest (`package.json` `pi` field) and conventional
  resource directories will be used rather than custom package discovery.
- devenv's official flake template will provide the Nix/devenv baseline.

## Steps

- [x] Initialize the repository from the official devenv flake template and
      minimally enable Node.js 24.
- [x] Add the private npm-workspace root, Apache-2.0 license, locked Pi 0.84.2
      development dependencies, and root test/package-validation scripts.
- [x] Copy `fast`, `footer`, and `yolo` into package workspaces with version
      `0.1.0`, Apache-2.0 metadata, `pi-package` keywords, explicit Pi
      manifests, public publish configuration, restricted `files`, and `*`
      peer ranges for Pi-provided runtime imports.
- [x] Port or adapt tests, add an import smoke check for all three entrypoints,
      and expose one root validation command using Node's test runner followed
      by `npm pack --dry-run --workspaces`.
- [x] Configure `enterTest` to invoke that root validation command and add CI
      that runs `devenv test` on pushes and pull requests using the official
      Nix/Cachix setup.
- [x] Add a tag-triggered GitHub Actions release job with `contents: read` and
      `id-token: write`; resolve the tag by exact comparison with each workspace
      manifest's `<unscoped-name>-<version>`, reject no/multiple matches, run the
      full validation, and publish exactly that public workspace through npm
      OIDC.
- [x] Document exact tags (`pi-fast-x.x.x`, `pi-footer-x.x.x`, and
      `pi-yolo-x.x.x`), local first-publication bootstrap, npm trusted-publisher
      setup for this public GitHub repository, and version/tag verification.
      State clearly that initial `0.1.0` publication is a later manual bootstrap
      with no matching release tag, and that this implementation performs no
      npm publication, Git tag creation, or push.

## Verification

- Run `nix flake check --impure` (the generated devenv flake needs the
  checkout path), enter the default dev shell, and run `devenv test`.
- Run all migrated extension/package tests and entrypoint import smoke checks.
- Inspect every package tarball with `npm pack --dry-run` to ensure only intended
  resources and metadata ship.
- Load each packed/local package in Pi and smoke-test `/fast`, `/footer`, and
  `/yolo`; verify the separately installed permission-system prerequisite and
  that the personal policy is absent from the YOLO tarball.
- Exercise the release workflow's tag parser with valid, unknown, malformed,
  and version-mismatch tags; verify a sample flow without publishing until
  explicitly approved.
- After the user performs the first local npm publish and configures each npm
  package's trusted publisher, publish a later test version by tag and confirm
  npm provenance plus the `latest` dist-tag.
