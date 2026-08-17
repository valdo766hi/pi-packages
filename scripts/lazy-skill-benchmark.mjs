import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	escapeXml,
	renderCompactCatalog,
} from "../packages/lazy-skill-tool/src/catalog.ts";

const fixtureRoot = resolve("test/fixtures/lazy-skills");
const skills = readdirSync(fixtureRoot, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.sort((a, b) => a.name.localeCompare(b.name))
	.map((entry) => {
		const baseDir = join(fixtureRoot, entry.name);
		const filePath = join(baseDir, "SKILL.md");
		const { frontmatter } = parseFrontmatter(readFileSync(filePath, "utf8"));
		return {
			name: frontmatter.name,
			description: frontmatter.description,
			filePath,
			baseDir,
			disableModelInvocation: false,
		};
	});

const stock = [
	"The following skills provide specialized instructions for specific tasks.",
	"Use the read tool to load a skill's file when the task matches its description.",
	"When a skill file references a relative path, resolve it against the skill directory.",
	"",
	"<available_skills>",
	...skills.flatMap((skill) => [
		"  <skill>",
		`    <name>${escapeXml(skill.name)}</name>`,
		`    <description>${escapeXml(skill.description)}</description>`,
		`    <location>${escapeXml(skill.filePath)}</location>`,
		"  </skill>",
	]),
	"</available_skills>",
].join("\n");
const compact = renderCompactCatalog(skills, { descriptionMax: 240 });

function stats(value) {
	return { chars: value.length, bytes: Buffer.byteLength(value, "utf8") };
}

function reduction(before, after) {
	return `${(((before - after) / before) * 100).toFixed(1)}%`;
}

const stockStats = stats(stock);
const compactStats = stats(compact);
process.stdout.write(
	[
		`Skills: ${skills.length}`,
		"",
		"Stock catalog:",
		`  chars: ${stockStats.chars}`,
		`  bytes: ${stockStats.bytes}`,
		"",
		"Compact catalog:",
		`  chars: ${compactStats.chars}`,
		`  bytes: ${compactStats.bytes}`,
		"",
		"Reduction:",
		`  chars: ${reduction(stockStats.chars, compactStats.chars)}`,
		`  bytes: ${reduction(stockStats.bytes, compactStats.bytes)}`,
		"",
	].join("\n"),
);
