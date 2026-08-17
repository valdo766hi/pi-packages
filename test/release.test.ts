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
	for (const workspace of ["fast", "footer", "yolo"]) {
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
