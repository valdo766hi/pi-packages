export type LazySkillErrorCode =
	| "SKILL_NOT_FOUND"
	| "SKILL_DENIED"
	| "SKILL_APPROVAL_REQUIRED"
	| "SKILL_APPROVAL_REJECTED"
	| "SKILL_DISABLED_FOR_MODEL"
	| "SKILL_UNREADABLE"
	| "SKILL_INVALID_UTF8"
	| "SKILL_INVALID_FRONTMATTER"
	| "SKILL_NAME_CHANGED"
	| "SKILL_EMPTY"
	| "SKILL_OFFSET_INVALID"
	| "SKILL_SOURCE_TOO_LARGE"
	| "SKILL_TOOL_CONFLICT"
	| "SKILL_PROMPT_INTEGRATION_FAILED"
	| "SKILL_SOURCE_CHANGED"
	| "SKILL_SEARCH_CURSOR_STALE"
	| "POLICY_INVALID";

const SAFE_MESSAGES: Readonly<Record<LazySkillErrorCode, string>> = {
	SKILL_NOT_FOUND: "Skill is not available.",
	SKILL_DENIED: "Skill loading is denied by policy.",
	SKILL_APPROVAL_REQUIRED: "Skill loading requires interactive approval.",
	SKILL_APPROVAL_REJECTED: "Skill loading was rejected.",
	SKILL_DISABLED_FOR_MODEL: "Skill is unavailable to model tool calls.",
	SKILL_UNREADABLE: "Skill instructions are unreadable.",
	SKILL_INVALID_UTF8: "Skill instructions are not valid UTF-8.",
	SKILL_INVALID_FRONTMATTER: "Skill frontmatter is invalid.",
	SKILL_NAME_CHANGED: "Skill name changed after discovery.",
	SKILL_EMPTY: "Skill has no instructions.",
	SKILL_OFFSET_INVALID: "Skill continuation offset is invalid.",
	SKILL_SOURCE_TOO_LARGE: "Skill source exceeds the configured size limit.",
	SKILL_TOOL_CONFLICT:
		"Skill loading is unavailable because another tool owns the skill name.",
	SKILL_PROMPT_INTEGRATION_FAILED:
		"Skill loading is blocked because prompt integration could not be verified.",
	SKILL_SOURCE_CHANGED:
		"Skill continuation is invalid because the source changed.",
	SKILL_SEARCH_CURSOR_STALE:
		"Skill search cursor is stale for the current registry.",
	POLICY_INVALID:
		"Skill loading is blocked because policy configuration is invalid.",
};

export interface LazySkillErrorDetails {
	readonly requestedName?: string;
	readonly canonicalPath?: string;
	readonly configPath?: string;
	readonly diagnostics?: readonly string[];
	readonly cause?: unknown;
}

export class LazySkillError extends Error {
	readonly code: LazySkillErrorCode;
	readonly details: LazySkillErrorDetails;

	constructor(code: LazySkillErrorCode, details: LazySkillErrorDetails = {}) {
		super(`[${code}] ${SAFE_MESSAGES[code]}`);
		this.name = "LazySkillError";
		this.code = code;
		this.details = details;
	}
}

export function lazySkillErrorMessage(code: LazySkillErrorCode): string {
	return `[${code}] ${SAFE_MESSAGES[code]}`;
}

export function isLazySkillError(error: unknown): error is LazySkillError {
	return error instanceof LazySkillError;
}
