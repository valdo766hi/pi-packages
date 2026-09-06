import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import type { Skill } from "@earendil-works/pi-coding-agent";
import {
	buildRegistry,
	renderSafeCatalog,
	userInvokableSkills,
	visibleSkills,
	type RuntimeSkill,
} from "./src/catalog.ts";
import {
	DEFAULT_MAX_SOURCE_BYTES,
	loadConfig,
	parseConfigText,
	readConfig,
} from "./src/config.ts";
import { compileSkillPolicy } from "./src/policy.ts";
import { buildSkillSnapshot } from "./src/snapshot.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

function skill(
	name: string,
	description: string,
	disabled = false,
	filePath = resolve("test", "skills", name, "SKILL.md"),
): Skill & RuntimeSkill {
	return {
		name,
		description,
		filePath,
		baseDir: dirname(filePath),
		disableModelInvocation: disabled,
		sourceInfo: {
			path: filePath,
			source: "test-source",
			scope: "temporary",
			origin: "top-level",
			baseDir: dirname(filePath),
		},
	};
}

test("configuration defaults to safe routing, complete descriptions, and no sampling", () => {
	const result = readConfig({});
	assert.equal(result.config.routing, "safe");
	assert.equal(result.config.maxDescriptionCharacters, 0);
	assert.equal(result.config.resourceFileSampleLimit, 0);
	assert.equal(result.config.maxSourceBytes, DEFAULT_MAX_SOURCE_BYTES);
	assert.equal(result.policy.valid, true);
	assert.equal(result.policy.decision("anything"), "allow");
	assert.deepEqual(result.warnings, []);
	const legacy = readConfig({ PI_LAZY_SKILL_FILE_LIMIT: "1" });
	assert.equal(legacy.config.resourceFileSampleLimit, 1);
	assert.equal(legacy.warnings.length, 1);
	assert.match(legacy.warnings[0] ?? "", /deprecated compatibility overrides/u);
});

test("configuration parser accepts the documented shape and rejects ambiguity", () => {
	for (const action of ["allow", "ask", "deny"] as const) {
		assert.deepEqual(parseConfigText(`{"permission":{"skill":"${action}"}}`), {
			skillPermission: action,
		});
	}
	const parsed = parseConfigText(
		JSON.stringify({
			$schema: "https://example.invalid/schema.json",
			routing: "adaptive",
			permission: {
				skill: {
					default: "deny",
					rules: [{ pattern: "public-*", action: "allow" }],
				},
			},
			maxDescriptionCharacters: 80,
			maxSourceBytes: 2048,
			resourceFileSampleLimit: 2,
		}),
	);
	assert.equal(parsed.routing, "adaptive");
	assert.deepEqual(parsed.skillPermission, {
		default: "deny",
		rules: [{ pattern: "public-*", action: "allow" }],
	});
	assert.equal(parsed.maxDescriptionCharacters, 80);
	assert.equal(parsed.maxSourceBytes, 2048);
	assert.equal(parsed.resourceFileSampleLimit, 2);

	for (const invalid of [
		'{"routing":"safe","routing":"adaptive"}',
		'{"unknown":true}',
		'{"permission":{"other":"deny"}}',
		'{"permission":{"skill":"prompt"}}',
		'{"permission":{"skill":{"rules":[{"pattern":"","action":"deny"}]}}}',
		'{"permission":{"skill":{"rules":[{"pattern":"*","action":"deny","extra":1}]}}}',
		'{"maxSourceBytes":100}',
		'{"resourceFileSampleLimit":51}',
		'{"maxDescriptionCharacters":1025}',
	]) {
		assert.throws(() => parseConfigText(invalid), Error, invalid);
	}
});

test("wildcard policy is literal except for star and question mark and uses last match", () => {
	const policy = compileSkillPolicy({
		defaultAction: "allow",
		rules: [
			{ pattern: "production-*", action: "ask" },
			{ pattern: "production-safe", action: "allow" },
			{ pattern: "literal.+[x]", action: "deny" },
			{ pattern: "file-?", action: "ask" },
			{ pattern: "multi-*-*-end", action: "deny" },
		],
	});
	assert.equal(policy.decision("production-risky"), "ask");
	assert.equal(policy.decision("production-safe"), "allow");
	assert.equal(policy.decision("literal.+[x]"), "deny");
	assert.equal(policy.decision("literalZZx"), "allow");
	assert.equal(policy.decision("file-a"), "ask");
	assert.equal(policy.decision("file-日"), "ask");
	assert.equal(policy.decision("file-ab"), "allow");
	assert.equal(policy.decision("multi-one-two-end"), "deny");
	assert.equal(policy.decision("multi--two-end"), "deny");
	assert.ok(Object.isFrozen(policy.rules));
	assert.ok(Object.isFrozen(policy.rules[0]));
});

test("global and trusted-project policies merge explicitly before environment overrides", async () => {
	const root = await mkdtemp(join(tmpdir(), "lazy-policy-"));
	temporaryDirectories.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		join(agentDir, "lazy-skill.json"),
		JSON.stringify({
			routing: "safe",
			permission: {
				skill: {
					default: "ask",
					rules: [{ pattern: "shared-*", action: "deny" }],
				},
			},
			resourceFileSampleLimit: 1,
		}),
	);
	await writeFile(
		join(cwd, ".pi", "lazy-skill.json"),
		JSON.stringify({
			permission: {
				skill: {
					rules: [{ pattern: "shared-safe", action: "allow" }],
				},
			},
		}),
	);

	const trusted = await loadConfig({
		cwd,
		agentDir,
		projectTrusted: true,
		env: {
			PI_LAZY_SKILL_ROUTING: "adaptive",
			PI_LAZY_SKILL_FILE_LIMIT: "2",
		},
	});
	assert.equal(trusted.config.routing, "adaptive");
	assert.equal(trusted.config.resourceFileSampleLimit, 2);
	assert.equal(trusted.policy.decision("ordinary"), "ask");
	assert.equal(trusted.policy.decision("shared-risky"), "deny");
	assert.equal(trusted.policy.decision("shared-safe"), "allow");
	assert.equal(trusted.policy.rules.length, 2);
	assert.deepEqual(trusted.configPaths, [
		join(agentDir, "lazy-skill.json"),
		join(cwd, ".pi", "lazy-skill.json"),
	]);

	const untrusted = await loadConfig({
		cwd,
		agentDir,
		projectTrusted: false,
		env: {},
	});
	assert.equal(untrusted.policy.decision("shared-safe"), "deny");
	assert.deepEqual(untrusted.configPaths, [join(agentDir, "lazy-skill.json")]);
});

test("an invalid existing policy file fails closed while an untrusted project file is ignored", async () => {
	const root = await mkdtemp(join(tmpdir(), "lazy-invalid-policy-"));
	temporaryDirectories.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	await mkdir(agentDir, { recursive: true });
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await writeFile(join(agentDir, "lazy-skill.json"), "{}");
	await writeFile(
		join(cwd, ".pi", "lazy-skill.json"),
		'{"permission":{"skill":"prompt"}}',
	);

	const untrusted = await loadConfig({
		cwd,
		agentDir,
		projectTrusted: false,
		env: {},
	});
	assert.equal(untrusted.policy.valid, true);
	assert.equal(untrusted.policy.decision("alpha"), "allow");

	const trusted = await loadConfig({
		cwd,
		agentDir,
		projectTrusted: true,
		env: {},
	});
	assert.equal(trusted.policy.valid, false);
	assert.equal(trusted.policy.restrictive, true);
	assert.equal(trusted.policy.decision("alpha"), "deny");
	assert.equal(trusted.error?.code, "POLICY_INVALID");
	assert.equal(
		trusted.error?.details.configPath,
		join(cwd, ".pi", "lazy-skill.json"),
	);
	assert.match(
		trusted.error?.details.diagnostics?.[0] ?? "",
		/expected "allow", "ask", or "deny"/u,
	);
});

test("safe catalog preserves every visible complete description without paths", () => {
	const skills = [
		skill("zeta", "  Zeta\nfull & detailed description.  "),
		skill("alpha", "Unicode 日本語 <complete> description."),
		skill("ask-me", "Ask description."),
		skill("denied", "Denied secret description."),
		skill("disabled", "Explicit-only description.", true),
	];
	const policy = compileSkillPolicy({
		rules: [
			{ pattern: "ask-*", action: "ask" },
			{ pattern: "denied", action: "deny" },
		],
	});
	const registry = buildRegistry(skills);
	assert.ok(Object.isFrozen(registry));
	assert.equal("set" in registry, false);
	const visible = visibleSkills(registry, policy);
	const invokable = userInvokableSkills(registry, policy);
	assert.deepEqual(
		visible.map(({ name }) => name),
		["alpha", "ask-me", "zeta"],
	);
	assert.deepEqual(
		invokable.map(({ name }) => name),
		["alpha", "ask-me", "disabled", "zeta"],
	);
	const catalog = renderSafeCatalog(visible);
	assert.equal(
		catalog,
		[
			"<available_skills>",
			'<skill name="alpha">Unicode 日本語 &lt;complete&gt; description.</skill>',
			'<skill name="ask-me">Ask description.</skill>',
			'<skill name="zeta">Zeta full &amp; detailed description.</skill>',
			"</available_skills>",
		].join("\n"),
	);
	assert.ok(!catalog.includes("Denied secret"));
	assert.ok(!catalog.includes("Explicit-only"));
	assert.ok(!catalog.includes("/SKILL.md"));
	assert.equal(renderSafeCatalog([]), "");
});

test("safe and full snapshots are identical while truncation is an explicit opt-out", () => {
	const longDescription =
		"first complete routing phrase and a late decisive trigger";
	const base = readConfig({}).config;
	const policy = compileSkillPolicy();
	const safe = buildSkillSnapshot(
		[skill("alpha", longDescription)],
		base,
		policy,
	);
	const full = buildSkillSnapshot(
		[skill("alpha", longDescription)],
		{ ...base, routing: "full" },
		policy,
	);
	assert.equal(safe.safeCatalog, full.safeCatalog);
	assert.notEqual(safe.fingerprint, full.fingerprint);
	assert.ok(safe.safeCatalog.includes("late decisive trigger"));
	const bounded = buildSkillSnapshot(
		[skill("alpha", longDescription)],
		{ ...base, maxSourceBytes: base.maxSourceBytes + 1 },
		policy,
	);
	assert.notEqual(safe.fingerprint, bounded.fingerprint);
	const truncated = buildSkillSnapshot(
		[skill("alpha", longDescription)],
		{ ...base, maxDescriptionCharacters: 20, descriptionMax: 20 },
		policy,
	);
	assert.ok(!truncated.safeCatalog.includes("late decisive trigger"));
});
