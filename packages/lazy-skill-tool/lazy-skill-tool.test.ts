import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, test } from "node:test";
import {
	formatSkillsForPrompt,
	loadSkillsFromDir,
	parseFrontmatter,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	Skill,
} from "@earendil-works/pi-coding-agent";
import lazySkillTool from "./src/index.ts";
import {
	buildRegistry,
	compactDescription,
	escapeXml,
	DEFAULT_DESCRIPTION_MAX,
	DEFAULT_FILE_LIMIT,
	readConfig,
	renderCompactCatalog,
	visibleSkills,
	type RuntimeSkill,
} from "./src/catalog.ts";
import { sampleRelatedFiles } from "./src/files.ts";
import { loadSkill, MAX_SKILL_BYTES, MAX_SKILL_LINES } from "./src/loader.ts";
import { appendSkillCatalog, transformSkillPrompt } from "./src/prompt.ts";

const FIXTURE_ROOT = resolve("test/fixtures/lazy-skills");
const REAL_WORLD_FIXTURE_ROOT = resolve("test/fixtures/lazy-real-world");
const CONFIG = {
	descriptionMax: DEFAULT_DESCRIPTION_MAX,
	fileLimit: DEFAULT_FILE_LIMIT,
	disabled: false,
} as const;

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

function makeSkill(
	name: string,
	description: string,
	filePath = join(FIXTURE_ROOT, name, "SKILL.md"),
	baseDir = dirname(filePath),
	disableModelInvocation = false,
): Skill {
	return {
		name,
		description,
		filePath,
		baseDir,
		sourceInfo: {
			path: filePath,
			source: "test",
			scope: "temporary",
			origin: "top-level",
		},
		disableModelInvocation,
	};
}

function promptOptions(
	skills: Skill[],
	selectedTools?: string[],
): BeforeEvent["systemPromptOptions"] {
	return {
		cwd: FIXTURE_ROOT,
		skills,
		...(selectedTools === undefined ? {} : { selectedTools }),
	};
}

function nativePrompt(skillNames: string[] = ["native"]): string {
	const entries = skillNames.flatMap((name) => [
		"  <skill>",
		`    <name>${escapeXml(name)}</name>`,
		`    <description>${escapeXml(name)} catalog entry</description>`,
		`    <location>/private/${escapeXml(name)}/SKILL.md</location>`,
		"  </skill>",
	]);
	return [
		"Keep this unrelated XML: <before><value>1</value></before>.",
		"",
		"The following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory.",
		"",
		"<available_skills>",
		...entries,
		"</available_skills>",
		"",
		"Keep this unrelated XML: <after><value>2</value></after>.",
	].join("\n");
}

test("catalog builds a fresh deterministic registry", () => {
	const first = makeSkill("zeta", "zeta");
	const duplicate = makeSkill("alpha", "duplicate");
	const registry = buildRegistry([
		makeSkill("zeta", " zeta\n description "),
		makeSkill("alpha", "alpha description"),
		makeSkill("hidden", "hidden description", undefined, undefined, true),
		duplicate,
	]);

	assert.deepEqual([...registry.keys()], ["zeta", "alpha", "hidden"]);
	assert.equal(registry.get("alpha")?.description, "alpha description");
	assert.deepEqual(
		visibleSkills(registry).map((skill) => skill.name),
		["alpha", "zeta"],
	);
	assert.notEqual(registry.get("zeta"), first);
});

test("catalog config preserves complete descriptions and defaults to no sampling", () => {
	assert.equal(readConfig({}).config.descriptionMax, 0);
	assert.equal(readConfig({}).config.fileLimit, 0);

	const result = readConfig({
		PI_LAZY_SKILL_DESCRIPTION_MAX: "0",
		PI_LAZY_SKILL_FILE_LIMIT: "50",
		PI_LAZY_SKILL_DISABLE: "yes",
	});
	assert.deepEqual(result.warnings, []);
	assert.deepEqual(result.config, {
		descriptionMax: 0,
		fileLimit: 50,
		disabled: true,
	});

	const invalid = readConfig({
		PI_LAZY_SKILL_DESCRIPTION_MAX: "-1",
		PI_LAZY_SKILL_FILE_LIMIT: "not-an-int",
	});
	assert.equal(invalid.config.descriptionMax, DEFAULT_DESCRIPTION_MAX);
	assert.equal(invalid.config.fileLimit, DEFAULT_FILE_LIMIT);
	assert.equal(invalid.warnings.length, 2);
});

test("catalog descriptions normalize whitespace, preserve short text, and truncate at words", () => {
	assert.equal(
		compactDescription("  short\n description  ", 240),
		"short description",
	);
	const long = compactDescription(
		"one two three four five six seven eight nine ten",
		20,
	);
	assert.ok(long.endsWith("…"));
	assert.ok(long.length <= 20);
	assert.ok(!long.endsWith(" "));
	assert.equal(
		compactDescription("😀 skill description", 0),
		"😀 skill description",
	);
	assert.equal(compactDescription("123456789😀 trigger", 11), "123456789😀…");
});

test("compact catalog is sorted, escaped, and hides disabled skills", () => {
	const catalog = renderCompactCatalog(
		[
			makeSkill("zeta", "Zeta & details"),
			makeSkill("alpha", "Alpha <details>"),
			makeSkill("a&b", "Unicode 😀 & details"),
			makeSkill("hidden", "Do not show", undefined, undefined, true),
		],
		CONFIG,
	);

	assert.ok(
		catalog.indexOf("<name>alpha</name>") < catalog.indexOf("<name>zeta</name>"),
	);
	assert.ok(catalog.includes("Alpha &lt;details&gt;"));
	assert.ok(catalog.includes("Zeta &amp; details"));
	assert.ok(catalog.includes("<name>a&amp;b</name>"));
	assert.ok(!catalog.includes("hidden"));
	assert.ok(!catalog.includes("/test/fixtures"));
	assert.ok(!catalog.includes("  <skill>"));
	assert.match(
		catalog,
		/<skill><name>alpha<\/name><description>[^\n]+<\/description><\/skill>/u,
	);
});

test("compact catalogs meet deterministic byte-reduction budgets", () => {
	const fixtureSkills = loadSkillsFromDir({
		dir: FIXTURE_ROOT,
		source: "byte-budget",
	}).skills;
	const fixtureNative = formatSkillsForPrompt(fixtureSkills);
	const fixtureCompact = renderCompactCatalog(fixtureSkills, CONFIG);
	assert.ok(
		Buffer.byteLength(fixtureCompact) <= Buffer.byteLength(fixtureNative) * 0.55,
	);

	for (const count of [10, 50, 100]) {
		const skills = Array.from({ length: count }, (_, index) =>
			makeSkill(
				`skill-${String(index).padStart(3, "0")}`,
				`Use this skill for focused workflow ${index}, validation, and related project tasks.`,
			),
		);
		const nativeCatalog = formatSkillsForPrompt(skills);
		const compactCatalog = renderCompactCatalog(skills, CONFIG);
		assert.ok(
			Buffer.byteLength(compactCatalog) <= Buffer.byteLength(nativeCatalog) * 0.7,
			`compact ${count}-skill catalog exceeded its byte budget`,
		);
	}
});

test("real-world skill preserves late routing triggers and complete instructions", async () => {
	const discovered = loadSkillsFromDir({
		dir: REAL_WORLD_FIXTURE_ROOT,
		source: "real-world-test",
	});
	assert.deepEqual(discovered.diagnostics, []);
	assert.equal(discovered.skills.length, 1);
	const skill = discovered.skills[0];
	assert.ok(skill);
	assert.ok(skill.description.length > 240);
	const lateTrigger = "investigate a real production incident";
	assert.ok(skill.description.includes(lateTrigger));

	const catalog = renderCompactCatalog(discovered.skills, CONFIG);
	assert.ok(catalog.includes(lateTrigger));
	const optInTruncatedCatalog = renderCompactCatalog(discovered.skills, {
		descriptionMax: 240,
	});
	assert.ok(!optInTruncatedCatalog.includes(lateTrigger));

	const source = await readFile(skill.filePath, "utf8");
	assert.ok(Buffer.byteLength(source) > 9_000);
	const frontmatter =
		parseFrontmatter<Record<string, unknown>>(source).frontmatter;
	assert.equal(
		frontmatter.compatibility,
		"Requires access to retained production telemetry and an incident timeline; never mutates production without explicit approval.",
	);
	assert.equal(frontmatter["allowed-tools"], "read bash");
	assert.deepEqual(frontmatter.metadata, {
		workflow: "incident-response",
		safety: "approval-required",
	});
	const loaded = await loadSkill(skill as RuntimeSkill, DEFAULT_FILE_LIMIT);
	assert.equal(loaded.body, source);
	assert.equal(loaded.bodyTruncation.truncated, false);
	assert.equal(loaded.bodyOffset, 1);
	assert.equal(loaded.bodyColumn, 1);
	assert.equal(loaded.nextOffset, undefined);

	const sampled = await loadSkill(skill as RuntimeSkill, 10);
	assert.deepEqual(
		sampled.relatedFiles.files.map((file) => relative(skill.baseDir, file)),
		["references/severity.md", "templates/status-update.md"],
	);
});

test("prompt transformation replaces only the bounded native skill section", () => {
	const alpha = makeSkill("alpha", "Alpha description");
	const result = transformSkillPrompt(nativePrompt(["alpha"]), [alpha], CONFIG);

	assert.equal(result.replaced, true);
	assert.equal(result.warning, undefined);
	assert.ok(result.prompt.includes("<before><value>1</value></before>"));
	assert.ok(result.prompt.includes("<after><value>2</value></after>"));
	assert.ok(result.prompt.includes("<name>alpha</name>"));
	assert.ok(!result.prompt.includes("/private/native/SKILL.md"));
	assert.ok(!result.prompt.includes("# Alpha"));
	assert.ok(!result.prompt.includes("Use the read tool"));
	assert.ok(result.prompt.includes("with the `skill` tool"));
	assert.equal(
		transformSkillPrompt(result.prompt, [alpha], CONFIG).prompt,
		result.prompt,
	);
});

test("prompt transformation selects the canonical block when unrelated XML uses the same tag", () => {
	const alpha = makeSkill("alpha", "Alpha description");
	const prompt = [
		"<available_skills><skill><name>example</name></skill></available_skills>",
		"",
		nativePrompt(["alpha"]),
	].join("\n");
	const result = transformSkillPrompt(prompt, [alpha], CONFIG);

	assert.equal(result.warning, undefined);
	assert.ok(result.prompt.includes("<name>example</name>"));
	assert.ok(result.prompt.includes("<name>alpha</name>"));
	assert.ok(!result.prompt.includes("/private/native/SKILL.md"));
});

test("prompt transformation recognizes changed wording and leaves empty catalogs alone", () => {
	const changed = nativePrompt(["alpha"]).replace(
		"Use the read tool to load a skill's file when the task matches its description.",
		"Read the matching skill instructions before continuing.",
	);
	const transformed = transformSkillPrompt(
		changed,
		[makeSkill("alpha", "alpha")],
		CONFIG,
	);
	assert.equal(transformed.replaced, true);
	assert.ok(
		!transformed.prompt.includes("Read the matching skill instructions"),
	);

	const empty = transformSkillPrompt(nativePrompt([]), [], CONFIG);
	assert.equal(empty.replaced, false);
	assert.equal(empty.prompt, nativePrompt([]));

	const unrelated = transformSkillPrompt(
		"<available_skills><skill><name>alpha</name></skill></available_skills>",
		[makeSkill("alpha", "alpha")],
		CONFIG,
	);
	assert.equal(unrelated.replaced, false);
});

test("prompt transformation does not replace a later same-name superset block", () => {
	const alpha = makeSkill("alpha", "Alpha description");
	const prompt = [
		nativePrompt(["alpha"]),
		"",
		"<available_skills><skill><name>alpha</name></skill><skill><name>custom</name></skill></available_skills>",
	].join("\n");
	const result = transformSkillPrompt(prompt, [alpha], CONFIG);

	assert.equal(result.replaced, true);
	assert.ok(result.prompt.includes("<name>custom</name>"));
	assert.ok(!result.prompt.includes("/private/alpha/SKILL.md"));
});

test("skill-only mode appends a compact catalog without replacing unrelated XML", () => {
	const alpha = makeSkill("alpha", "Alpha description");
	const prompt =
		"Base prompt\n<available_skills><custom>keep</custom></available_skills>";
	const result = appendSkillCatalog(prompt, [alpha], CONFIG);

	assert.equal(result.replaced, true);
	assert.ok(result.prompt.startsWith(prompt));
	assert.ok(result.prompt.includes("<custom>keep</custom>"));
	assert.ok(result.prompt.includes("<name>alpha</name>"));
});

test("prompt transformation fails safely when tags are missing or incomplete", () => {
	const unchanged = "<unrelated><available>value</available></unrelated>";
	const missing = transformSkillPrompt(
		unchanged,
		[makeSkill("alpha", "alpha")],
		CONFIG,
	);
	assert.equal(missing.prompt, unchanged);
	assert.equal(missing.replaced, false);
	assert.match(missing.warning ?? "", /available_skills/);

	const incomplete = transformSkillPrompt(
		"before\n<available_skills>\n<skill>",
		[makeSkill("alpha", "alpha")],
		CONFIG,
	);
	assert.equal(incomplete.prompt, "before\n<available_skills>\n<skill>");
	assert.equal(incomplete.replaced, false);

	const customOnly = transformSkillPrompt(
		"<available_skills><skill>custom</skill></available_skills>",
		[],
		CONFIG,
	);
	assert.equal(customOnly.replaced, false);
	assert.equal(customOnly.warning, undefined);
});

test("loader defaults to no sampling and can list fixture resources", async () => {
	const alpha = makeSkill(
		"alpha",
		"Alpha",
		join(FIXTURE_ROOT, "alpha", "SKILL.md"),
		join(FIXTURE_ROOT, "alpha"),
	);
	const noSample = await loadSkill(
		alpha as unknown as RuntimeSkill,
		DEFAULT_FILE_LIMIT,
	);
	assert.deepEqual(noSample.relatedFiles.files, []);
	assert.equal(noSample.relatedFiles.directoriesVisited, 0);

	const loaded = await loadSkill(alpha as unknown as RuntimeSkill, 10);
	assert.ok(loaded.body.includes("# Alpha"));
	assert.ok(loaded.body.includes("name: alpha"));
	assert.deepEqual(
		loaded.relatedFiles.files.map((file) =>
			relative(join(FIXTURE_ROOT, "alpha"), file),
		),
		["references/NOTES.md", "scripts/alpha.sh"],
	);
	assert.equal(
		loaded.relatedFiles.files.some((file) => file.endsWith("SKILL.md")),
		false,
	);
});

test("sampler skips hidden, dependency, and symlink entries", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-lazy-files-"));
	temporaryDirectories.push(directory);
	await writeFile(
		join(directory, "SKILL.md"),
		"---\nname: temp\ndescription: temp\n---\nbody\n",
	);
	await mkdir(join(directory, "real"));
	await writeFile(join(directory, "real", "one.txt"), "one");
	const exact = await sampleRelatedFiles(
		directory,
		join(directory, "SKILL.md"),
		1,
	);
	assert.equal(exact.truncated, false);
	assert.equal(exact.directoriesVisited, 2);
	const missingDirectory = await sampleRelatedFiles(
		join(directory, "missing"),
		join(directory, "missing", "SKILL.md"),
		1,
	);
	assert.equal(missingDirectory.truncated, true);
	await symlink(join(directory, "real"), join(directory, "linked"), "dir");
	const sampled = await sampleRelatedFiles(
		directory,
		join(directory, "SKILL.md"),
		10,
	);
	assert.deepEqual(sampled.files, [join(directory, "real", "one.txt")]);

	const linkedRoot = `${directory}-root-link`;
	temporaryDirectories.push(linkedRoot);
	await symlink(directory, linkedRoot, "dir");
	const rootSample = await sampleRelatedFiles(
		linkedRoot,
		join(linkedRoot, "SKILL.md"),
		10,
	);
	assert.deepEqual(rootSample.files, [join(linkedRoot, "real", "one.txt")]);

	const skippedDirectory = await mkdtemp(join(tmpdir(), "pi-lazy-skipped-"));
	temporaryDirectories.push(skippedDirectory);
	await writeFile(join(skippedDirectory, "SKILL.md"), "primary\n");
	await mkdir(join(skippedDirectory, ".hidden"));
	await writeFile(join(skippedDirectory, ".hidden", "secret.txt"), "secret");
	await mkdir(join(skippedDirectory, "node_modules"));
	await writeFile(join(skippedDirectory, "node_modules", "package.js"), "pkg");
	await mkdir(join(skippedDirectory, "z-deep"));
	await writeFile(join(skippedDirectory, "z-deep", "later.txt"), "later");
	await writeFile(join(skippedDirectory, "a-visible.txt"), "visible");
	const stopped = await sampleRelatedFiles(
		skippedDirectory,
		join(skippedDirectory, "SKILL.md"),
		1,
	);
	assert.deepEqual(stopped.files, [join(skippedDirectory, "a-visible.txt")]);
	assert.equal(stopped.directoriesVisited, 1);
	assert.equal(stopped.truncated, true);
});

test("sampler bounds wide traversal and preserves cancellation", async () => {
	const limited = await sampleRelatedFiles(
		FIXTURE_ROOT,
		join(FIXTURE_ROOT, "alpha", "SKILL.md"),
		1,
	);
	assert.equal(limited.files.length, 1);
	assert.equal(limited.truncated, true);

	const hugeDirectory = await mkdtemp(join(tmpdir(), "pi-lazy-many-"));
	temporaryDirectories.push(hugeDirectory);
	const hugePrimary = join(hugeDirectory, "SKILL.md");
	await writeFile(
		hugePrimary,
		"---\nname: huge\ndescription: huge\n---\nbody\n",
	);
	await Promise.all(
		Array.from({ length: 1025 }, (_, index) =>
			writeFile(join(hugeDirectory, `resource-${index}.txt`), String(index)),
		),
	);
	const bounded = await sampleRelatedFiles(hugeDirectory, hugePrimary, 1);
	assert.equal(bounded.files.length, 1);
	assert.equal(bounded.truncated, true);
	assert.equal(bounded.directoriesVisited, 1);

	const controller = new AbortController();
	const pending = sampleRelatedFiles(
		hugeDirectory,
		hugePrimary,
		1,
		controller.signal,
	);
	setImmediate(() => controller.abort());
	await assert.rejects(
		pending,
		(error: unknown) => error instanceof Error && error.name === "AbortError",
	);
});

test("loader mirrors Pi fallback-name semantics after file changes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-lazy-fallback-name-"));
	temporaryDirectories.push(directory);

	const aliasDirectory = join(directory, "alpha");
	await mkdir(aliasDirectory);
	const aliasPath = join(aliasDirectory, "SKILL.md");
	await writeFile(aliasPath, "---\ndescription: alias removed\n---\nbody\n");
	await assert.rejects(
		loadSkill(
			makeSkill(
				"custom",
				"alias removed",
				aliasPath,
				aliasDirectory,
			) as unknown as RuntimeSkill,
			0,
		),
		/invalid frontmatter/,
	);

	const fallbackDirectory = join(directory, "fallback");
	await mkdir(fallbackDirectory);
	const fallbackPath = join(fallbackDirectory, "SKILL.md");
	const fallbackSkill = makeSkill(
		"fallback",
		"fallback",
		fallbackPath,
		fallbackDirectory,
	) as unknown as RuntimeSkill;
	const fallbackSource = "---\ndescription: fallback\n---\nbody\n";
	await writeFile(fallbackPath, fallbackSource);
	assert.equal((await loadSkill(fallbackSkill, 0)).body, fallbackSource);

	const emptyNameSource = '---\nname: ""\ndescription: fallback\n---\nbody\n';
	await writeFile(fallbackPath, emptyNameSource);
	assert.equal((await loadSkill(fallbackSkill, 0)).body, emptyNameSource);
});

test("loader errors are concise and cancellation is preserved", async () => {
	const missing = makeSkill(
		"missing",
		"missing",
		join(FIXTURE_ROOT, "missing", "SKILL.md"),
		FIXTURE_ROOT,
	);
	await assert.rejects(
		loadSkill(missing as unknown as RuntimeSkill, 10),
		/no longer readable/,
	);

	const directory = await mkdtemp(join(tmpdir(), "pi-lazy-invalid-"));
	temporaryDirectories.push(directory);
	const invalidPath = join(directory, "SKILL.md");
	await writeFile(invalidPath, "---\nname: [broken\n---\nbody\n");
	await assert.rejects(
		loadSkill(
			makeSkill(
				"invalid",
				"invalid",
				invalidPath,
				directory,
			) as unknown as RuntimeSkill,
			10,
		),
		/invalid frontmatter/,
	);

	const unterminatedPath = join(directory, "unterminated.md");
	await writeFile(
		unterminatedPath,
		"---\nname: unterminated\ndescription: broken\nbody\n",
	);
	await assert.rejects(
		loadSkill(
			makeSkill(
				"unterminated",
				"broken",
				unterminatedPath,
				directory,
			) as unknown as RuntimeSkill,
			0,
		),
		/invalid frontmatter/,
	);

	const mismatchedPath = join(directory, "mismatched.md");
	await writeFile(
		mismatchedPath,
		"---\nname: renamed\ndescription: changed\n---\nbody\n",
	);
	await assert.rejects(
		loadSkill(
			makeSkill(
				"original",
				"changed",
				mismatchedPath,
				directory,
			) as unknown as RuntimeSkill,
			0,
		),
		/invalid frontmatter/,
	);

	const unavailablePath = join(directory, "unavailable.md");
	await writeFile(
		unavailablePath,
		"---\nname: unavailable\ndescription: changed\ndisable-model-invocation: true\n---\nbody\n",
	);
	await assert.rejects(
		loadSkill(
			makeSkill(
				"unavailable",
				"changed",
				unavailablePath,
				directory,
			) as unknown as RuntimeSkill,
			0,
		),
		/no longer available/,
	);

	const emptyPath = join(directory, "empty.md");
	await writeFile(emptyPath, "---\nname: empty\ndescription: empty\n---\n\n");
	await assert.rejects(
		loadSkill(
			makeSkill("empty", "empty", emptyPath, directory) as unknown as RuntimeSkill,
			0,
		),
		/has no instructions/,
	);

	const invalidUtf8Path = join(directory, "invalid-utf8.md");
	await writeFile(invalidUtf8Path, Buffer.from([0xff, 0xfe, 0xfd]));
	await assert.rejects(
		loadSkill(
			makeSkill(
				"invalid-utf8",
				"invalid",
				invalidUtf8Path,
				directory,
			) as unknown as RuntimeSkill,
			0,
		),
		/not valid UTF-8/,
	);

	const oversizedPath = join(directory, "oversized.md");
	const largeBody = Array.from(
		{ length: 700 },
		(_, index) =>
			`## Verification checkpoint ${String(index + 1).padStart(3, "0")}: compare customer-impact metrics with the known-good cohort, record UTC evidence, and stop before any unapproved production mutation.`,
	).join("\n");
	assert.ok(Buffer.byteLength(largeBody) > MAX_SKILL_BYTES);
	const largeSource = `---\nname: oversized\ndescription: oversized\n---\n${largeBody}`;
	await writeFile(oversizedPath, largeSource);
	const oversizedSkill = makeSkill(
		"oversized",
		"oversized",
		oversizedPath,
		directory,
	) as unknown as RuntimeSkill;
	const expectedFirstChunk = truncateHead(largeSource);
	const firstChunk = await loadSkill(oversizedSkill, 0);
	assert.equal(firstChunk.body, expectedFirstChunk.content);
	assert.equal(firstChunk.bodyTruncation.truncated, true);
	assert.equal(firstChunk.nextOffset, expectedFirstChunk.outputLines + 1);
	assert.ok(firstChunk.nextOffset);

	const sourceLines = largeSource.split("\n");
	const chunks = [firstChunk.body];
	let chunk = firstChunk;
	let continuationCount = 0;
	while (chunk.nextOffset !== undefined) {
		const offset = chunk.nextOffset;
		const remainingSource = sourceLines.slice(offset - 1).join("\n");
		chunk = await loadSkill(oversizedSkill, 0, undefined, offset);
		assert.equal(chunk.body, truncateHead(remainingSource).content);
		assert.equal(chunk.bodyOffset, offset);
		assert.equal(chunk.bodyColumn, 1);
		chunks.push(chunk.body);
		continuationCount += 1;
		assert.ok(continuationCount < 10, "large skill continuation did not finish");
	}
	assert.equal(chunks.join("\n"), largeSource);
	assert.equal(chunk.bodyTruncation.truncated, false);
	await assert.rejects(
		loadSkill(oversizedSkill, 0, undefined, sourceLines.length + 1),
		/beyond its 704 file lines/,
	);

	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		loadSkill(
			makeSkill("alpha", "alpha") as unknown as RuntimeSkill,
			10,
			controller.signal,
		),
		(error: unknown) => error instanceof Error && error.name === "AbortError",
	);

	const reason = new Error("custom cancellation");
	const customController = new AbortController();
	customController.abort(reason);
	await assert.rejects(
		loadSkill(
			makeSkill("alpha", "alpha") as unknown as RuntimeSkill,
			10,
			customController.signal,
		),
		(error: unknown) => error === reason,
	);
	await assert.rejects(
		sampleRelatedFiles(
			FIXTURE_ROOT,
			join(FIXTURE_ROOT, "alpha", "SKILL.md"),
			10,
			customController.signal,
		),
		(error: unknown) => error === reason,
	);
});

test("loader matches Pi's 2,000-line boundary with exact continuation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-lazy-line-limit-"));
	temporaryDirectories.push(directory);
	const filePath = join(directory, "SKILL.md");
	const sourceLines = [
		"---",
		"name: line-limit",
		"description: line limit parity",
		"---",
		...Array.from(
			{ length: MAX_SKILL_LINES + 50 },
			(_, index) => `step-${index + 1}`,
		),
	];
	const source = sourceLines.join("\n");
	await writeFile(filePath, source);
	const skill = makeSkill(
		"line-limit",
		"line limit parity",
		filePath,
		directory,
	) as unknown as RuntimeSkill;

	const first = await loadSkill(skill, 0);
	assert.equal(first.bodyTruncation.truncatedBy, "lines");
	assert.equal(first.bodyTruncation.outputLines, MAX_SKILL_LINES);
	assert.equal(first.nextOffset, MAX_SKILL_LINES + 1);
	const second = await loadSkill(skill, 0, undefined, first.nextOffset);
	assert.equal(second.body, sourceLines.slice(MAX_SKILL_LINES).join("\n"));
	assert.equal(second.bodyTruncation.truncated, false);
});

test("loader makes progress through one instruction line larger than 50 KiB", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-lazy-long-line-"));
	temporaryDirectories.push(directory);
	const filePath = join(directory, "SKILL.md");
	const giantLine = "verify-🔥-evidence;".repeat(8_000);
	const sourceLines = [
		"---",
		"name: long-line",
		"description: oversized line parity",
		"---",
		giantLine,
		"Final instruction after the oversized line.",
	];
	await writeFile(filePath, sourceLines.join("\n"));
	const skill = makeSkill(
		"long-line",
		"oversized line parity",
		filePath,
		directory,
	) as unknown as RuntimeSkill;

	const prelude = await loadSkill(skill, 0);
	assert.equal(prelude.nextOffset, 5);
	assert.equal(prelude.nextColumn, 1);

	let column = 1;
	let reconstructedLine = "";
	let calls = 0;
	while (true) {
		const chunk = await loadSkill(skill, 0, undefined, 5, column);
		const newline = chunk.body.indexOf("\n");
		if (newline !== -1) {
			reconstructedLine += chunk.body.slice(0, newline);
			assert.equal(
				chunk.body.slice(newline + 1),
				"Final instruction after the oversized line.",
			);
			assert.equal(chunk.nextOffset, undefined);
			break;
		}
		reconstructedLine += chunk.body;
		assert.equal(chunk.bodyTruncation.content, chunk.body);
		assert.equal(
			chunk.bodyTruncation.outputBytes,
			Buffer.byteLength(chunk.body, "utf8"),
		);
		assert.equal(chunk.bodyTruncation.outputLines, 1);
		assert.equal(chunk.bodyTruncation.lastLinePartial, true);
		assert.equal(chunk.nextOffset, 5);
		assert.ok((chunk.nextColumn ?? 0) > column);
		column = chunk.nextColumn ?? 0;
		calls += 1;
		assert.ok(calls < 10, "oversized-line continuation did not progress");
	}
	assert.equal(reconstructedLine, giantLine);
});

type BeforeEvent = Pick<
	BeforeAgentStartEvent,
	"systemPrompt" | "systemPromptOptions"
>;
type RegisteredTool = {
	name: string;
	description: string;
	execute: (
		toolCallId: string,
		params: { name: string; offset?: number; column?: number },
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: ExtensionContext,
	) => Promise<{
		content: Array<{ type: "text"; text: string }>;
		details: Record<string, unknown>;
	}>;
};

type Harness = {
	tool: RegisteredTool;
	registerCount: number;
	before: (event: BeforeEvent) => Promise<unknown>;
};

function createHarness(): Harness {
	const handlers = new Map<
		string,
		(event: BeforeEvent) => Promise<unknown> | unknown
	>();
	let tool: RegisteredTool | undefined;
	let registerCount = 0;
	const pi = {
		registerTool(definition: unknown) {
			registerCount += 1;
			tool = definition as RegisteredTool;
		},
		on(event: string, handler: unknown) {
			handlers.set(
				event,
				handler as (event: BeforeEvent) => Promise<unknown> | unknown,
			);
		},
	};

	lazySkillTool(pi as unknown as ExtensionAPI);
	assert.ok(tool);
	return {
		tool,
		registerCount,
		before: async (event) => handlers.get("before_agent_start")!(event),
	};
}

function combinedText(result: {
	content: Array<{ type: "text"; text: string }>;
}): string {
	return result.content.map((item) => item.text).join("\n");
}

test("Pi canonical discovery feeds the lazy prompt and tool harness", async () => {
	const discovered = loadSkillsFromDir({ dir: FIXTURE_ROOT, source: "path" });
	assert.deepEqual(discovered.skills.map((skill) => skill.name).sort(), [
		"alpha",
		"beta",
	]);
	assert.deepEqual(discovered.diagnostics, []);

	const stockPrompt = [
		"System instructions before skills.",
		formatSkillsForPrompt(discovered.skills),
		"System instructions after skills.",
	].join("\n\n");
	assert.ok(stockPrompt.includes("/alpha/SKILL.md"));
	assert.ok(stockPrompt.includes("/beta/SKILL.md"));

	const harness = createHarness();
	const result = (await harness.before({
		systemPrompt: stockPrompt,
		systemPromptOptions: promptOptions(discovered.skills),
	})) as { systemPrompt: string };
	assert.ok(result.systemPrompt.includes("<name>alpha</name>"));
	assert.ok(result.systemPrompt.includes("<name>beta</name>"));
	assert.ok(!result.systemPrompt.includes("/alpha/SKILL.md"));
	assert.ok(!result.systemPrompt.includes("# Alpha"));

	const loaded = await harness.tool.execute(
		"call",
		{ name: "alpha" },
		undefined,
		undefined,
		{} as ExtensionContext,
	);
	assert.ok(loaded.content[0]?.text.includes("# Alpha"));
});

test("real-world discovered skill routes and loads end to end without fidelity loss", async () => {
	const discovered = loadSkillsFromDir({
		dir: REAL_WORLD_FIXTURE_ROOT,
		source: "real-world-harness",
	});
	const skill = discovered.skills[0];
	assert.ok(skill);
	const stockPrompt = formatSkillsForPrompt(discovered.skills);
	const harness = createHarness();
	const transformed = (await harness.before({
		systemPrompt: stockPrompt,
		systemPromptOptions: {
			cwd: REAL_WORLD_FIXTURE_ROOT,
			skills: discovered.skills,
			selectedTools: ["skill"],
		},
	})) as { systemPrompt: string };
	assert.ok(
		transformed.systemPrompt.includes("investigate a real production incident"),
	);

	const expectedBody = await readFile(skill.filePath, "utf8");
	const result = await harness.tool.execute(
		"real-world",
		{ name: skill.name },
		undefined,
		undefined,
		{} as ExtensionContext,
	);
	const context = result.content[1]?.text ?? "";
	assert.equal(result.content[0]?.text, expectedBody);
	assert.ok(expectedBody.includes("compatibility: Requires access"));
	assert.ok(expectedBody.includes("allowed-tools: read bash"));
	assert.ok(context.includes(`Skill file: ${skill.filePath}`));
	assert.ok(context.includes(`Base directory: ${skill.baseDir}`));
	assert.equal(result.details.bodyTruncated, false);
	assert.equal(result.details.bodyOffset, 1);
});

test("large skill instructions continue through the same tool at Pi read limits", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-lazy-large-tool-"));
	temporaryDirectories.push(directory);
	const filePath = join(directory, "SKILL.md");
	const lines = Array.from(
		{ length: 700 },
		(_, index) =>
			`Checkpoint ${index + 1}: verify the affected customer cohort against a known-good baseline, preserve the UTC evidence link, and do not mutate production without explicit approval.`,
	);
	const source = `---\nname: large-real-workflow\ndescription: Load a large operational workflow\n---\n${lines.join("\n")}`;
	const sourceLines = source.split("\n");
	await writeFile(filePath, source);
	const skill = makeSkill(
		"large-real-workflow",
		"Load a large operational workflow",
		filePath,
		directory,
	);
	const harness = createHarness();
	await harness.before({
		systemPrompt: nativePrompt([skill.name]),
		systemPromptOptions: promptOptions([skill]),
	});

	const first = await harness.tool.execute(
		"large-first",
		{ name: skill.name },
		undefined,
		undefined,
		{} as ExtensionContext,
	);
	const firstText = first.content[0]?.text ?? "";
	assert.equal(first.details.bodyTruncated, true);
	assert.equal(typeof first.details.nextOffset, "number");
	assert.ok(firstText.includes(lines[0] ?? "missing first line"));
	assert.ok(combinedText(first).includes("Continue with skill"));

	let result = first;
	let continuationCount = 0;
	while (result.details.bodyTruncated === true) {
		const nextOffset = result.details.nextOffset as number;
		result = await harness.tool.execute(
			"large-continuation",
			{ name: skill.name, offset: nextOffset },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const text = result.content[0]?.text ?? "";
		assert.ok(
			text.includes(sourceLines[nextOffset - 1] ?? "missing continuation"),
		);
		assert.equal(result.details.bodyOffset, nextOffset);
		assert.equal(result.details.directoriesVisited, 0);
		continuationCount += 1;
		assert.ok(continuationCount < 10, "tool continuation did not finish");
	}
	assert.ok(
		(result.content[0]?.text ?? "").includes(
			lines.at(-1) ?? "missing final line",
		),
	);
	assert.equal(result.details.bodyTruncated, false);
});

test("extension registers one static tool and keeps prompt and registry synchronized", async () => {
	const harness = createHarness();
	assert.equal(harness.registerCount, 1);
	assert.ok(!harness.tool.description.includes("<skill>"));
	assert.ok(!harness.tool.description.includes("alpha"));

	const alpha = makeSkill("alpha", "Alpha description");
	const beta = makeSkill("beta", "Beta description");
	const first = (await harness.before({
		systemPrompt: nativePrompt(["alpha", "beta"]),
		systemPromptOptions: promptOptions([alpha, beta]),
	})) as { systemPrompt: string };
	assert.ok(first.systemPrompt.includes("<name>alpha</name>"));
	assert.ok(first.systemPrompt.includes("<name>beta</name>"));
	assert.ok(!first.systemPrompt.includes(alpha.filePath));

	const loaded = await harness.tool.execute(
		"call",
		{ name: "alpha" },
		undefined,
		undefined,
		{} as ExtensionContext,
	);
	assert.ok(loaded.content[0]?.text.includes("# Alpha"));
	assert.ok(loaded.content[1]?.text.includes("Base directory:"));
	assert.ok(!combinedText(loaded).includes("<skill_files"));
	assert.equal(loaded.details.directoriesVisited, 0);

	const next = (await harness.before({
		systemPrompt: nativePrompt(["beta"]),
		systemPromptOptions: promptOptions([beta]),
	})) as { systemPrompt: string };
	assert.ok(!next.systemPrompt.includes("<name>alpha</name>"));
	await assert.rejects(
		harness.tool.execute(
			"call",
			{ name: "alpha" },
			undefined,
			undefined,
			{} as ExtensionContext,
		),
		/Skill "alpha" is not available/,
	);

	await harness.before({
		systemPrompt: nativePrompt([]),
		systemPromptOptions: promptOptions([]),
	});
	for (const name of [
		"../../etc/passwd",
		"/etc/passwd",
		"foo/../../bar",
		"",
		"<script>",
	]) {
		await assert.rejects(
			harness.tool.execute(
				"call",
				{ name },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
			/is not available/,
		);
	}
});

test("extension only rewrites prompts when its tool is active", async () => {
	const harness = createHarness();
	const alpha = makeSkill("alpha", "Alpha description");

	const readOnly = await harness.before({
		systemPrompt: nativePrompt(["alpha"]),
		systemPromptOptions: promptOptions([alpha], ["read"]),
	});
	assert.equal(readOnly, undefined);

	const skillOnly = (await harness.before({
		systemPrompt: "Base prompt",
		systemPromptOptions: promptOptions([alpha], ["skill"]),
	})) as { systemPrompt: string };
	assert.ok(skillOnly.systemPrompt.includes("<name>alpha</name>"));
	assert.ok(!skillOnly.systemPrompt.includes(alpha.filePath));

	const inactive = await harness.before({
		systemPrompt: nativePrompt(["alpha"]),
		systemPromptOptions: promptOptions([alpha], ["read", "bash"]),
	});
	assert.equal(inactive, undefined);
});

test("skill-only mode continues oversized lines without read or bash", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-lazy-skill-only-line-"));
	temporaryDirectories.push(directory);
	const filePath = join(directory, "SKILL.md");
	const giantLine = "customer-impact-🔥;".repeat(4_000);
	await writeFile(
		filePath,
		[
			"---",
			"name: skill-only-long-line",
			"description: skill-only oversized line",
			"---",
			giantLine,
			"Safe final instruction.",
		].join("\n"),
	);
	const skill = makeSkill(
		"skill-only-long-line",
		"skill-only oversized line",
		filePath,
		directory,
	);
	const harness = createHarness();
	await harness.before({
		systemPrompt: "Base prompt",
		systemPromptOptions: promptOptions([skill], ["skill"]),
	});

	let result = await harness.tool.execute(
		"skill-only-prelude",
		{ name: skill.name },
		undefined,
		undefined,
		{} as ExtensionContext,
	);
	assert.equal(result.details.nextOffset, 5);
	let previousColumn = 0;
	let calls = 0;
	while (result.details.bodyTruncated === true) {
		const nextOffset = result.details.nextOffset as number;
		const nextColumn = result.details.nextColumn as number;
		result = await harness.tool.execute(
			"skill-only-continuation",
			{ name: skill.name, offset: nextOffset, column: nextColumn },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const text = combinedText(result);
		assert.ok(!text.includes("Use the read tool"));
		assert.ok(!text.includes("Use bash"));
		if (result.details.bodyTruncated === true) {
			assert.equal(result.details.nextOffset, 5);
			assert.ok((result.details.nextColumn as number) > previousColumn);
			previousColumn = result.details.nextColumn as number;
		}
		calls += 1;
		assert.ok(calls < 10, "skill-only oversized line did not finish");
	}
	assert.ok((result.content[0]?.text ?? "").includes("Safe final instruction."));
});

test("tool preserves raw skill source and escapes metadata fields", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-lazy-&-"));
	temporaryDirectories.push(directory);
	const filePath = join(directory, "SKILL.md");
	const source = "---\nname: a&b\ndescription: special\n---\n# Special\n]]>\n";
	await writeFile(filePath, source);
	await writeFile(join(directory, "notes.md"), "notes\n");

	const harness = createHarness();
	const skill = makeSkill("a&b", "special", filePath, directory);
	await harness.before({
		systemPrompt: nativePrompt(["a&b"]),
		systemPromptOptions: promptOptions([skill]),
	});
	const result = await harness.tool.execute(
		"call",
		{ name: "a&b" },
		undefined,
		undefined,
		{} as ExtensionContext,
	);
	const context = result.content[1]?.text ?? "";
	assert.equal(result.content[0]?.text, source);
	assert.ok(context.includes('<skill_context name="a&amp;b"'));
	assert.ok(
		context.includes(`Base directory: ${directory.replaceAll("&", "&amp;")}`),
	);
	assert.ok(!context.includes("notes.md"));
	assert.ok(!context.includes("<skill_files"));
});

test("CDATA-like source stays exact and model-facing growth remains bounded", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-lazy-cdata-limit-"));
	temporaryDirectories.push(directory);
	const filePath = join(directory, "SKILL.md");
	const cdataTerminator = "]]>";
	const giantLine = cdataTerminator.repeat(20_000);
	await writeFile(
		filePath,
		[
			"---",
			"name: cdata-limit",
			"description: preserve literal CDATA terminators",
			"---",
			giantLine,
		].join("\n"),
	);
	const skill = makeSkill(
		"cdata-limit",
		"preserve literal CDATA terminators",
		filePath,
		directory,
	);
	const harness = createHarness();
	await harness.before({
		systemPrompt: nativePrompt([skill.name]),
		systemPromptOptions: promptOptions([skill]),
	});
	const prelude = await harness.tool.execute(
		"cdata-prelude",
		{ name: skill.name },
		undefined,
		undefined,
		{} as ExtensionContext,
	);
	const chunk = await harness.tool.execute(
		"cdata-chunk",
		{
			name: skill.name,
			offset: prelude.details.nextOffset as number,
			column: prelude.details.nextColumn as number,
		},
		undefined,
		undefined,
		{} as ExtensionContext,
	);
	const rawChunk = chunk.content[0]?.text ?? "";
	assert.ok(giantLine.startsWith(rawChunk));
	assert.ok(rawChunk.includes(cdataTerminator));
	assert.ok(!rawChunk.includes("]]]]><![CDATA[>"));
	assert.ok(Buffer.byteLength(rawChunk) <= MAX_SKILL_BYTES);
	assert.ok(Buffer.byteLength(combinedText(chunk)) <= MAX_SKILL_BYTES + 2_048);
	assert.equal(chunk.details.bodyTruncated, true);
});

test("configured related-file sampling stays bounded and explicit", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-lazy-output-files-"));
	temporaryDirectories.push(directory);
	const filePath = join(directory, "SKILL.md");
	await writeFile(
		filePath,
		"---\nname: sampled\ndescription: sampled\n---\n# Sampled\n",
	);
	await writeFile(join(directory, "notes.md"), "notes\n");

	const previous = process.env.PI_LAZY_SKILL_FILE_LIMIT;
	process.env.PI_LAZY_SKILL_FILE_LIMIT = "1";
	let harness: Harness;
	try {
		harness = createHarness();
	} finally {
		if (previous === undefined) delete process.env.PI_LAZY_SKILL_FILE_LIMIT;
		else process.env.PI_LAZY_SKILL_FILE_LIMIT = previous;
	}

	const sampled = makeSkill("sampled", "sampled", filePath, directory);
	await harness.before({
		systemPrompt: nativePrompt(["sampled"]),
		systemPromptOptions: promptOptions([sampled]),
	});
	const result = await harness.tool.execute(
		"call",
		{ name: "sampled" },
		undefined,
		undefined,
		{} as ExtensionContext,
	);
	const text = result.content[1]?.text ?? "";
	assert.ok(text.includes('<skill_files truncated="false">'));
	assert.ok(text.includes(`<file>${join(directory, "notes.md")}</file>`));
	assert.equal(result.details.directoriesVisited, 1);
});

test("model-disabled skills remain unavailable to the tool", async () => {
	const harness = createHarness();
	const hidden = makeSkill("hidden", "hidden", undefined, undefined, true);
	const result = await harness.before({
		systemPrompt: nativePrompt([]),
		systemPromptOptions: promptOptions([hidden]),
	});
	assert.equal(result, undefined);
	await assert.rejects(
		harness.tool.execute(
			"call",
			{ name: "hidden" },
			undefined,
			undefined,
			{} as ExtensionContext,
		),
		/is not available/,
	);
});

test("disabled environment leaves native Pi behavior untouched", () => {
	const previous = process.env.PI_LAZY_SKILL_DISABLE;
	process.env.PI_LAZY_SKILL_DISABLE = "1";
	try {
		const handlers = new Map<string, unknown>();
		let registerCount = 0;
		const pi = {
			registerTool() {
				registerCount += 1;
			},
			on(event: string, handler: unknown) {
				handlers.set(event, handler);
			},
		};
		lazySkillTool(pi as unknown as ExtensionAPI);
		assert.equal(registerCount, 0);
		assert.equal(handlers.size, 0);
	} finally {
		if (previous === undefined) delete process.env.PI_LAZY_SKILL_DISABLE;
		else process.env.PI_LAZY_SKILL_DISABLE = previous;
	}
});

test("tool execution captures its registry snapshot", async () => {
	const harness = createHarness();
	const alpha = makeSkill("alpha", "Alpha description");
	const beta = makeSkill("beta", "Beta description");
	await harness.before({
		systemPrompt: nativePrompt(["alpha"]),
		systemPromptOptions: promptOptions([alpha]),
	});
	const pending = harness.tool.execute(
		"call",
		{ name: "alpha" },
		undefined,
		undefined,
		{} as ExtensionContext,
	);
	await harness.before({
		systemPrompt: nativePrompt(["beta"]),
		systemPromptOptions: promptOptions([beta]),
	});
	const result = await pending;
	assert.ok(result.content[0]?.text.includes("# Alpha"));
});
