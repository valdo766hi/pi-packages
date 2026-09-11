import { createHash } from "node:crypto";

export type SkillPermissionAction = "allow" | "ask" | "deny";

export interface SkillPermissionRule {
	readonly pattern: string;
	readonly action: SkillPermissionAction;
}

export interface SkillPermissionConfig {
	readonly default?: SkillPermissionAction;
	readonly rules?: readonly SkillPermissionRule[];
}

interface CompiledSkillPermissionRule extends SkillPermissionRule {
	readonly matches: (name: string) => boolean;
}

export interface CompiledSkillPolicy {
	readonly valid: boolean;
	readonly defaultAction: SkillPermissionAction;
	readonly rules: readonly SkillPermissionRule[];
	readonly fingerprint: string;
	readonly restrictive: boolean;
	readonly errors: readonly string[];
	decision(name: string): SkillPermissionAction;
}

export interface SkillPolicyInput {
	readonly defaultAction?: SkillPermissionAction;
	readonly rules?: readonly SkillPermissionRule[];
}

function stableFingerprint(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function wildcardMatcher(pattern: string): (name: string) => boolean {
	const patternCharacters = [...pattern];
	return (name: string): boolean => {
		const nameCharacters = [...name];
		let patternIndex = 0;
		let nameIndex = 0;
		let starIndex = -1;
		let starNameIndex = 0;

		while (nameIndex < nameCharacters.length) {
			const patternCharacter = patternCharacters[patternIndex];
			if (
				patternCharacter === "?" ||
				patternCharacter === nameCharacters[nameIndex]
			) {
				patternIndex += 1;
				nameIndex += 1;
				continue;
			}
			if (patternCharacter === "*") {
				starIndex = patternIndex;
				starNameIndex = nameIndex;
				patternIndex += 1;
				continue;
			}
			if (starIndex === -1) return false;
			patternIndex = starIndex + 1;
			starNameIndex += 1;
			nameIndex = starNameIndex;
		}
		while (patternCharacters[patternIndex] === "*") patternIndex += 1;
		return patternIndex === patternCharacters.length;
	};
}

export function compileSkillPolicy(
	input: SkillPolicyInput = {},
): CompiledSkillPolicy {
	const defaultAction = input.defaultAction ?? "allow";
	const rules = Object.freeze(
		(input.rules ?? []).map((rule) =>
			Object.freeze({ pattern: rule.pattern, action: rule.action }),
		),
	);
	const compiledRules: readonly CompiledSkillPermissionRule[] = rules.map(
		(rule) => ({ ...rule, matches: wildcardMatcher(rule.pattern) }),
	);
	const fingerprint = stableFingerprint({
		default: defaultAction,
		rules,
	});
	return Object.freeze({
		valid: true,
		defaultAction,
		rules,
		fingerprint,
		restrictive:
			defaultAction !== "allow" || rules.some((rule) => rule.action !== "allow"),
		errors: Object.freeze([]),
		decision(name: string): SkillPermissionAction {
			let action = defaultAction;
			for (const rule of compiledRules) {
				if (rule.matches(name)) action = rule.action;
			}
			return action;
		},
	});
}

export function invalidSkillPolicy(
	errors: readonly string[],
): CompiledSkillPolicy {
	const frozenErrors = Object.freeze([...errors]);
	return Object.freeze({
		valid: false,
		defaultAction: "deny",
		rules: Object.freeze([]),
		fingerprint: stableFingerprint({ invalid: frozenErrors }),
		restrictive: true,
		errors: frozenErrors,
		decision: () => "deny" as const,
	});
}
