import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";

const REPOSITORY_URL = "https://github.com/valdo766hi/pi-packages";

function resolveRelease(tag: string) {
	return JSON.parse(
		execFileSync(process.execPath, ["scripts/resolve-release.mjs", tag], {
			encoding: "utf8",
		}),
	);
}

test("published packages declare the provenance repository", () => {
	for (const workspace of ["fast", "footer", "yolo", "lazy-skill-tool"]) {
		const manifest = JSON.parse(
			readFileSync(`packages/${workspace}/package.json`, "utf8"),
		);
		assert.equal(manifest.repository?.url, REPOSITORY_URL, workspace);
	}
});

test("release tags resolve to the matching package version", () => {
	assert.deepEqual(resolveRelease("pi-fast-0.1.2"), {
		packageName: "@valdo766hi/pi-fast",
		version: "0.1.2",
		workspace: "packages/fast",
	});
	const lazyManifest = JSON.parse(
		readFileSync("packages/lazy-skill-tool/package.json", "utf8"),
	);
	assert.deepEqual(
		resolveRelease(`pi-lazy-skill-tool-${lazyManifest.version}`),
		{
			packageName: "@valdo766hi/pi-lazy-skill-tool",
			version: lazyManifest.version,
			workspace: "packages/lazy-skill-tool",
		},
	);
});

test("release tag resolution rejects unknown and malformed tags", () => {
	for (const tag of ["pi-fast-0.1.1", "pi-rtk-0.1.0", "v0.1.0"]) {
		const result = spawnSync(
			process.execPath,
			["scripts/resolve-release.mjs", tag],
			{
				encoding: "utf8",
			},
		);
		assert.notEqual(result.status, 0, tag);
	}
});
