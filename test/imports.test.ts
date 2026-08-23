import assert from "node:assert/strict";
import { test } from "node:test";
import fast from "../packages/fast/fast.ts";
import footer from "../packages/footer/footer.ts";
import yolo from "../packages/yolo/yolo.ts";
import lazySkillTool from "@valdo766hi/pi-lazy-skill-tool/src/index.ts";

test("all published Pi entrypoints import successfully", () => {
	assert.equal(typeof fast, "function");
	assert.equal(typeof footer, "function");
	assert.equal(typeof yolo, "function");
	assert.equal(typeof lazySkillTool, "function");
});
