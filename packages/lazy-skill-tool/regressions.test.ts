import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { assertLiveSkillAccess } from "./src/authorization.ts";
import { readConfig } from "./src/config.ts";
import { LazySkillError } from "./src/errors.ts";
import { compileSkillPolicy, invalidSkillPolicy } from "./src/policy.ts";
import { buildRoutingQuery, discloseAdaptiveCatalog, selectRoutingSkills } from "./src/routing.ts";
import { searchSkills } from "./src/search.ts";
import { buildSkillSnapshot } from "./src/snapshot.ts";

function skill(name: string, description: string): Skill {
	const baseDir = resolve("test-skills", name);
	const filePath = resolve(baseDir, "SKILL.md");
	return {
		name, description, baseDir, filePath, disableModelInvocation: false,
		sourceInfo: { path: filePath, source: "test", scope: "temporary", origin: "top-level" },
	};
}

const config = readConfig({}).config;
const databaseSkills = Array.from({ length: 12 }, (_, index) =>
	skill(`database-${index.toString().padStart(2, "0")}`, "Manage database backups and restores."),
);
const stale = { name: "LazySkillError", code: "SKILL_SEARCH_CURSOR_STALE" };

test("search continuation preserves the original query and validates explicit changes", () => {
	const snapshot = buildSkillSnapshot(databaseSkills, config, compileSkillPolicy());
	const first = searchSkills(snapshot, { query: "database" });
	assert.equal(first.skills.length, 10);
	assert.ok(first.nextCursor);
	const next = searchSkills(snapshot, { cursor: first.nextCursor });
	assert.equal(next.query, "database");
	assert.equal(next.skills.length, 2);
	assert.equal(next.hasMore, false);
	assert.equal(new Set([...first.skills, ...next.skills].map((item) => item.name)).size, 12);
	assert.deepEqual(searchSkills(snapshot, { cursor: first.nextCursor, query: " database " }), next);
	for (const query of ["", "restore"]) {
		assert.throws(() => searchSkills(snapshot, { cursor: first.nextCursor, query }), stale);
	}
	for (const changed of [
		buildSkillSnapshot(databaseSkills.slice(1), config, snapshot.policy),
		buildSkillSnapshot(databaseSkills, config, compileSkillPolicy({ defaultAction: "ask" })),
	]) {
		assert.throws(() => searchSkills(changed, { cursor: first.nextCursor }), stale);
	}
});

test("malformed cursor JSON always produces a typed stale-cursor error", () => {
	const snapshot = buildSkillSnapshot(databaseSkills, config, compileSkillPolicy());
	const valid = { v: 1, fingerprint: snapshot.fingerprint, query: "database", offset: 10 };
	for (const payload of [
		null, false, 1, "text", [], {}, { ...valid, query: null },
		...[0.5, -1, Number.MAX_SAFE_INTEGER + 1].map((offset) => ({ ...valid, offset })),
	]) {
		const cursor = Buffer.from(JSON.stringify(payload)).toString("base64url");
		assert.throws(() => searchSkills(snapshot, { cursor }), stale);
	}
	assert.throws(() => searchSkills(snapshot, { cursor: "not-json" }), stale);
});

test("multi-intent routing preserves short exact-name pins, including before truncation", () => {
	const skills = [
		skill("pptx", "Create slide decks and presentation files."),
		skill("create-dashboard", "Create Grafana dashboards and monitoring panels."),
		skill("generate-report", "Generate financial reports and summaries."),
		...Array.from({ length: 80 }, (_, index) =>
			skill(`office-${index}`, "Archive office records, invoices, receipts, stationery, and correspondence. ".repeat(6)),
		),
	];
	const snapshot = buildSkillSnapshot(skills, config, compileSkillPolicy());
	assert.ok(snapshot.routingIndex);
	assert.ok(snapshot.safeCatalogTokens > config.catalogTokenBudget);
	for (const prefix of ["", "Background information. ".repeat(1200)]) {
		const query = buildRoutingQuery(`Use pptx. ${prefix}Create a Grafana dashboard; Generate a financial report.`);
		const selection = selectRoutingSkills(snapshot.routingIndex, query);
		assert.ok(selection.mandatoryNames.includes("pptx"));
		const disclosure = discloseAdaptiveCatalog({
			index: snapshot.routingIndex, query, modelVisible: snapshot.modelVisible,
			safeCatalog: snapshot.safeCatalog, safeCatalogTokens: snapshot.safeCatalogTokens,
			catalogTokenBudget: config.catalogTokenBudget,
		});
		for (const name of ["pptx", "create-dashboard", "generate-report"]) {
			assert.ok(disclosure.describedSkills.some((item) => item.name === name), name);
			assert.ok(!disclosure.remainingNames.includes(name), name);
		}
	}
});

test("live policy changes invalidate in-flight authorization without mixing registry snapshots", () => {
	const skills = [skill("example", "Example instructions.")];
	const captured = buildSkillSnapshot(skills, config, compileSkillPolicy());
	const ask = buildSkillSnapshot(skills, config, compileSkillPolicy({ defaultAction: "ask" }));
	assert.throws(() => assertLiveSkillAccess(ask, captured, "example", true), {
		name: "LazySkillError", code: "SKILL_APPROVAL_REQUIRED",
	});
	const denied = buildSkillSnapshot(skills, config, compileSkillPolicy({ defaultAction: "deny" }));
	assert.throws(() => assertLiveSkillAccess(denied, captured, "example", true), {
		name: "LazySkillError", code: "SKILL_DENIED",
	});
	const invalid = buildSkillSnapshot(skills, config, invalidSkillPolicy(["invalid"]));
	assert.throws(() => assertLiveSkillAccess(invalid, captured, "example", true), {
		name: "LazySkillError", code: "POLICY_INVALID",
	});
	assert.throws(() => assertLiveSkillAccess(undefined, captured, "example", true), LazySkillError);
	const reloaded = buildSkillSnapshot([skill("example", "Changed metadata.")], config, captured.policy);
	assert.equal(assertLiveSkillAccess(reloaded, captured, "example", true), captured.byName.get("example"));
});
