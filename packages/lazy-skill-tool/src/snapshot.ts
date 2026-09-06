import { createHash } from "node:crypto";
import { estimateTokens, type Skill } from "@earendil-works/pi-coding-agent";
import {
	buildRegistry,
	renderSafeCatalog,
	userInvokableSkills,
	visibleSkills,
	type RuntimeSkill,
} from "./catalog.ts";
import type { LazySkillConfig } from "./config.ts";
import type { CompiledSkillPolicy } from "./policy.ts";
import { buildRoutingIndex, type RoutingIndex } from "./routing.ts";

export interface SkillSnapshot {
	readonly fingerprint: string;
	readonly canonicalSkills: readonly Skill[];
	readonly byName: ReadonlyMap<string, RuntimeSkill>;
	readonly modelVisible: readonly RuntimeSkill[];
	readonly userInvokable: readonly RuntimeSkill[];
	readonly policy: CompiledSkillPolicy;
	readonly config: LazySkillConfig;
	readonly routingIndex?: RoutingIndex;
	readonly safeCatalog: string;
	readonly safeCatalogTokens: number;
}

function fingerprint(
	skills: readonly RuntimeSkill[],
	policy: CompiledSkillPolicy,
	config: LazySkillConfig,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				policy: policy.fingerprint,
				routing: config.routing,
				maxDescriptionCharacters: config.maxDescriptionCharacters,
				maxSourceBytes: config.maxSourceBytes,
				resourceFileSampleLimit: config.resourceFileSampleLimit,
				disabled: config.disabled,
				skills: skills.map((skill) => [
					skill.name,
					skill.description,
					skill.filePath,
					skill.baseDir,
					skill.disableModelInvocation,
					skill.sourceInfo.path,
					skill.sourceInfo.source,
					skill.sourceInfo.scope,
					skill.sourceInfo.origin,
					skill.sourceInfo.baseDir ?? null,
				]),
			}),
		)
		.digest("hex");
}

function catalogTokens(catalog: string): number {
	if (!catalog) return 0;
	return estimateTokens({
		role: "user",
		content: [{ type: "text", text: catalog }],
		timestamp: 0,
	});
}

export function buildSkillSnapshot(
	canonicalSkills: readonly Skill[],
	config: LazySkillConfig,
	policy: CompiledSkillPolicy,
): SkillSnapshot {
	const byName = buildRegistry(canonicalSkills);
	const allSkills = Object.freeze([...byName.values()]);
	const modelVisible = Object.freeze(visibleSkills(byName, policy));
	const userInvokable = Object.freeze(userInvokableSkills(byName, policy));
	const safeCatalog = renderSafeCatalog(modelVisible, {
		maxDescriptionCharacters: config.maxDescriptionCharacters,
	});
	const routingIndex =
		policy.valid && config.routing === "adaptive"
			? buildRoutingIndex(modelVisible)
			: undefined;
	return Object.freeze({
		fingerprint: fingerprint(allSkills, policy, config),
		canonicalSkills: allSkills,
		byName,
		modelVisible,
		userInvokable,
		policy,
		config,
		...(routingIndex === undefined ? {} : { routingIndex }),
		safeCatalog,
		safeCatalogTokens: catalogTokens(safeCatalog),
	});
}
