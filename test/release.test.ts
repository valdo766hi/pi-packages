import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";

const REPOSITORY_URL = "https://github.com/valdo766hi/pi-packages";
const WORKSPACES = readdirSync("packages", { withFileTypes: true })
	.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

function resolveRelease(tag: string) {
	return JSON.parse(
		execFileSync(process.execPath, ["scripts/resolve-release.mjs", tag], {
			encoding: "utf8",
		}),
	);
}

test("published packages declare the provenance repository", () => {
	for (const workspace of WORKSPACES) {
		const manifest = JSON.parse(
			readFileSync(`packages/${workspace}/package.json`, "utf8"),
		);
		assert.equal(manifest.repository?.url, REPOSITORY_URL, workspace);
	}
});

test("release tags resolve to each workspace's current version", () => {
	for (const workspace of WORKSPACES) {
		const manifest = JSON.parse(readFileSync(`packages/${workspace}/package.json`, "utf8"));
		const tag = `${manifest.name.split("/").at(-1)}-${manifest.version}`;
		assert.deepEqual(resolveRelease(tag), {
			packageName: manifest.name,
			version: manifest.version,
			workspace: `packages/${workspace}`,
		});
	}
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
