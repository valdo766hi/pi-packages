import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const packages = ["fast", "footer", "lazy-skill-tool", "yolo"];
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;

if (!tag) {
	process.stderr.write("A release tag is required.\n");
	process.exit(2);
}

const matches = [];
for (const workspace of packages) {
	const path = resolve("packages", workspace, "package.json");
	let manifest;
	try {
		manifest = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		process.stderr.write(`Could not read ${path}: ${error}\n`);
		process.exit(2);
	}

	const packageName = manifest.name.split("/").at(-1);
	if (`${packageName}-${manifest.version}` === tag) {
		matches.push({
			packageName: manifest.name,
			version: manifest.version,
			workspace: `packages/${workspace}`,
		});
	}
}

if (matches.length !== 1) {
	process.stderr.write(
		`Tag ${tag} does not identify exactly one package/version.\n`,
	);
	process.exit(1);
}

process.stdout.write(`${JSON.stringify(matches[0])}\n`);
