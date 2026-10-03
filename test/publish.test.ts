import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const { parse } = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("yaml");
const workflow = parse(readFileSync(".github/workflows/publish.yml", "utf8")) as {
	on: {
		push: { tags: string[] };
		workflow_dispatch: { inputs: { tag: { required: boolean; type: string } } };
	};
	concurrency: { group: string; "cancel-in-progress": boolean };
	jobs: {
		publish: {
			env: { RELEASE_TAG: string };
			steps: Array<{
				name?: string; uses?: string; run?: string;
				with?: { ref?: string; "persist-credentials"?: boolean };
			}>;
		};
	};
};

test("manual and automatic publishing use the same validated tag and checkout", () => {
	assert.deepEqual(workflow.on.push.tags, ["pi-*-*.*.*"]);
	assert.equal(workflow.on.workflow_dispatch.inputs.tag.required, true);
	assert.equal(workflow.on.workflow_dispatch.inputs.tag.type, "string");
	assert.equal(workflow.jobs.publish.env.RELEASE_TAG, "${{ inputs.tag || github.ref_name }}");
	assert.equal(workflow.concurrency.group, "publish-${{ inputs.tag || github.ref_name }}");
	assert.equal(workflow.concurrency["cancel-in-progress"], false);

	const steps = workflow.jobs.publish.steps;
	assert.equal(steps[0]?.name, "Validate tag format");
	const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"));
	assert.equal(checkout?.with?.ref, "refs/tags/${{ env.RELEASE_TAG }}");
	assert.equal(checkout?.with?.["persist-credentials"], false);
	for (const name of ["Validate release tag", "Publish package", "Create GitHub release"]) {
		const script = steps.find((step) => step.name === name)?.run;
		assert.ok(script, name);
		assert.ok(script.includes('"$RELEASE_TAG"'), name);
		assert.ok(!script.includes("$GITHUB_REF_NAME"), name);
		assert.ok(!script.includes("${{ inputs."), "never interpolate inputs into shell code");
	}
});

test("release input validation rejects branches, ref expressions, and shell payloads", () => {
	const script = workflow.jobs.publish.steps[0]?.run;
	assert.ok(script);
	for (const [tag, valid] of [
		["pi-fast-0.1.3", true], ["pi-footer-0.2.1", true],
		["pi-yolo-0.1.7", true], ["pi-lazy-skill-tool-0.3.1", true],
		["", false], ["main", false], ["refs/tags/pi-fast-0.1.3", false],
		["pi-fast-0.1.3~1", false], ["pi-fast-0.1.3\n", false],
		["pi-fast-0.1.3; exit 0", false], ["pi-fast-0.1.3$(exit 0)", false],
	] as const) {
		const result: SpawnSyncReturns<string> = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
			env: { ...process.env, RELEASE_TAG: tag }, encoding: "utf8",
		});
		assert.equal(result.status === 0, valid, tag);
	}
});
