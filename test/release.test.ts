import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";

function resolveRelease(tag: string) {
	return JSON.parse(
		execFileSync(process.execPath, ["scripts/resolve-release.mjs", tag], {
			encoding: "utf8",
		}),
	);
}

test("release tags resolve to the matching package version", () => {
	assert.deepEqual(resolveRelease("pi-fast-0.1.1"), {
		packageName: "@valdo766hi/pi-fast",
		version: "0.1.1",
		workspace: "packages/fast",
	});
});

test("release tag resolution rejects unknown and malformed tags", () => {
	for (const tag of ["pi-fast-0.1.0", "pi-rtk-0.1.0", "v0.1.0"]) {
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
