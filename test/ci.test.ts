import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { posix } from "node:path";
import { test } from "node:test";

const { parse } = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("yaml");
const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as {
	on: {
		push: { branches: string[]; paths: string[]; tags?: string[] };
		pull_request: { paths: string[] };
	};
};

test("CI runs for code and build inputs, not documentation-only changes", () => {
	assert.deepEqual(workflow.on.push.branches, ["**"]);
	assert.equal(workflow.on.push.tags, undefined);
	assert.deepEqual(workflow.on.push.paths, workflow.on.pull_request.paths);
	const triggers = (files: string[]) => files.some((file) =>
		workflow.on.push.paths.some((pattern) => posix.matchesGlob(file, pattern)),
	);
	for (const file of [
		"packages/fast/fast.ts", "packages/footer/footer.test.ts",
		"packages/lazy-skill-tool/src/index.ts", "packages/yolo/package.json",
		"packages/lazy-skill-tool/schema/lazy-skill.schema.json",
		"scripts/resolve-release.mjs", "test/ci.test.ts",
		"test/fixtures/lazy-skills/alpha/SKILL.md",
		"test/fixtures/lazy-routing/corpus.json",
		"package.json", "package-lock.json", "tsconfig.json",
		"devenv.nix", "devenv.lock", "flake.nix", "flake.lock",
		"devenv.yaml", ".envrc", ".npmrc",
		".github/workflows/ci.yml", ".github/workflows/publish.yml",
		".github/workflows/future.yaml",
	]) {
		assert.equal(triggers([file]), true, file);
	}
	assert.equal(triggers([
		"README.md", "CHANGELOG.md", "LICENSE",
		"packages/fast/README.md", "packages/footer/CHANGELOG.md",
		"packages/yolo/LICENSE", "docs/guide.md", "docs/example.json",
		"docs/screenshot.png", ".github/ISSUE_TEMPLATE/bug.yml",
	]), false);
	assert.equal(triggers(["README.md", "packages/fast/fast.ts"]), true);
});
