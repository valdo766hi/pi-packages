import {
	parseSkillBlock,
	type ContextEvent,
	type ExtensionContext,
	type InputEvent,
	type ToolCallEvent,
	type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import type { RuntimeSkill } from "./catalog.ts";
import { LazySkillError, type LazySkillErrorCode } from "./errors.ts";
import { readValidatedSkillBody } from "./loader.ts";
import { pruneRoutingHintMessages } from "./prompt.ts";
import type { SkillSnapshot } from "./snapshot.ts";
import {
	canonicalComparisonPath,
	type SkillToolOwnership,
} from "./tool-ownership.ts";

const APPROVAL_CHOICES = [
	"Allow once",
	"Always allow this skill for this session",
	"Reject",
] as const;

interface AuthorizationTicket {
	readonly name: string;
	readonly canonicalPath: string;
	readonly policyFingerprint: string;
}

interface ExplicitAuthorizationTicket extends AuthorizationTicket {
	readonly args: string;
	readonly createdAt: number;
}

interface AuthorizedBlock extends AuthorizationTicket {
	readonly bodyFingerprint: string;
	readonly messageFingerprint: string;
}

export interface SkillAuthorizationState {
	readonly sessionApprovals: Set<string>;
	readonly modelTickets: Map<string, AuthorizationTicket>;
	readonly explicitTickets: ExplicitAuthorizationTicket[];
	readonly authorizedBlocks: Map<string, AuthorizedBlock>;
}

export interface ExplicitSkillInvocation {
	readonly prefix: "skill" | "lazy-skill";
	readonly name: string;
	readonly args: string;
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function approvalKey(
	name: string,
	canonicalPath: string,
	policyFingerprint: string,
): string {
	return `${policyFingerprint}\0${name}\0${canonicalPath}`;
}

function ticketFor(
	skill: RuntimeSkill,
	snapshot: SkillSnapshot,
): AuthorizationTicket {
	return {
		name: skill.name,
		canonicalPath: canonicalComparisonPath(skill.filePath),
		policyFingerprint: snapshot.policy.fingerprint,
	};
}

function ticketMatches(
	ticket: AuthorizationTicket,
	skill: RuntimeSkill,
	snapshot: SkillSnapshot,
): boolean {
	return (
		ticket.name === skill.name &&
		ticket.canonicalPath === canonicalComparisonPath(skill.filePath) &&
		ticket.policyFingerprint === snapshot.policy.fingerprint
	);
}

export function createAuthorizationState(): SkillAuthorizationState {
	return {
		sessionApprovals: new Set(),
		modelTickets: new Map(),
		explicitTickets: [],
		authorizedBlocks: new Map(),
	};
}

export function resetAuthorizationState(state: SkillAuthorizationState): void {
	state.sessionApprovals.clear();
	state.modelTickets.clear();
	state.explicitTickets.splice(0);
	state.authorizedBlocks.clear();
}

export function clearPendingExplicitAuthorizations(
	state: SkillAuthorizationState,
): void {
	state.explicitTickets.splice(0);
}

export function invalidateOneTimeTickets(
	state: SkillAuthorizationState,
): void {
	state.modelTickets.clear();
	state.explicitTickets.splice(0);
}

export function pruneAuthorizationState(
	state: SkillAuthorizationState,
	snapshot: SkillSnapshot,
): void {
	const validKeys = new Set(
		snapshot.userInvokable.map((skill) =>
			approvalKey(
				skill.name,
				canonicalComparisonPath(skill.filePath),
				snapshot.policy.fingerprint,
			),
		),
	);
	for (const key of state.sessionApprovals) {
		if (!validKeys.has(key)) state.sessionApprovals.delete(key);
	}
	for (const [toolCallId, ticket] of state.modelTickets) {
		const skill = snapshot.byName.get(ticket.name);
		if (!skill || !ticketMatches(ticket, skill, snapshot)) {
			state.modelTickets.delete(toolCallId);
		}
	}
	for (let index = state.explicitTickets.length - 1; index >= 0; index -= 1) {
		const ticket = state.explicitTickets[index];
		const skill = ticket ? snapshot.byName.get(ticket.name) : undefined;
		if (!ticket || !skill || !ticketMatches(ticket, skill, snapshot)) {
			state.explicitTickets.splice(index, 1);
		}
	}
	for (const [identity, binding] of state.authorizedBlocks) {
		const skill = snapshot.byName.get(binding.name);
		if (!skill || !ticketMatches(binding, skill, snapshot)) {
			state.authorizedBlocks.delete(identity);
		}
	}
}

function policySkill(
	snapshot: SkillSnapshot,
	name: string,
	modelInvocation: boolean,
): RuntimeSkill {
	if (!snapshot.policy.valid) throw new LazySkillError("POLICY_INVALID");
	const skill = snapshot.byName.get(name);
	if (!skill)
		throw new LazySkillError("SKILL_NOT_FOUND", { requestedName: name });
	if (snapshot.policy.decision(skill.name) === "deny") {
		throw new LazySkillError("SKILL_DENIED", { requestedName: name });
	}
	if (modelInvocation && skill.disableModelInvocation) {
		throw new LazySkillError("SKILL_DISABLED_FOR_MODEL", {
			requestedName: name,
			canonicalPath: skill.filePath,
		});
	}
	return skill;
}

type ApprovalResult = "allow" | "once" | "session";

async function authorizeAsk(
	skill: RuntimeSkill,
	snapshot: SkillSnapshot,
	state: SkillAuthorizationState,
	ctx: ExtensionContext,
): Promise<ApprovalResult> {
	if (snapshot.policy.decision(skill.name) !== "ask") return "allow";
	const key = approvalKey(
		skill.name,
		canonicalComparisonPath(skill.filePath),
		snapshot.policy.fingerprint,
	);
	if (state.sessionApprovals.has(key)) return "session";
	if (!ctx.hasUI) {
		throw new LazySkillError("SKILL_APPROVAL_REQUIRED", {
			requestedName: skill.name,
		});
	}
	const choice = await ctx.ui.select(`Load skill ${skill.name}?`, [
		...APPROVAL_CHOICES,
	]);
	if (choice === APPROVAL_CHOICES[0]) return "once";
	if (choice === APPROVAL_CHOICES[1]) {
		state.sessionApprovals.add(key);
		return "session";
	}
	throw new LazySkillError("SKILL_APPROVAL_REJECTED", {
		requestedName: skill.name,
	});
}

function conflictError(ownership: SkillToolOwnership): LazySkillError {
	return new LazySkillError("SKILL_TOOL_CONFLICT", {
		diagnostics: [
			`expected ${ownership.ownSource}`,
			`resolved ${ownership.resolvedSource ?? "<missing>"}`,
		],
	});
}

export async function authorizeModelToolCall(
	event: ToolCallEvent,
	ctx: ExtensionContext,
	snapshot: SkillSnapshot | undefined,
	state: SkillAuthorizationState,
	ownership: SkillToolOwnership,
): Promise<ToolCallEventResult | undefined> {
	if (event.toolName !== "skill") return undefined;
	try {
		if (ownership.status !== "owned") throw conflictError(ownership);
		if (!snapshot) throw new LazySkillError("POLICY_INVALID");
		const name = event.input.name;
		if (typeof name !== "string") throw new LazySkillError("SKILL_NOT_FOUND");
		const skill = policySkill(snapshot, name, true);
		const approval = await authorizeAsk(skill, snapshot, state, ctx);
		if (approval === "once") {
			state.modelTickets.set(event.toolCallId, ticketFor(skill, snapshot));
		}
		return undefined;
	} catch (error) {
		const failure =
			error instanceof LazySkillError
				? error
				: new LazySkillError("SKILL_UNREADABLE", { cause: error });
		return { block: true, reason: failure.message };
	}
}

export async function authorizeModelExecution(
	toolCallId: string,
	name: string,
	ctx: ExtensionContext,
	snapshot: SkillSnapshot,
	state: SkillAuthorizationState,
	ownership: SkillToolOwnership,
): Promise<RuntimeSkill> {
	if (ownership.status !== "owned") throw conflictError(ownership);
	const skill = policySkill(snapshot, name, true);
	if (snapshot.policy.decision(skill.name) !== "ask") return skill;
	const key = approvalKey(
		skill.name,
		canonicalComparisonPath(skill.filePath),
		snapshot.policy.fingerprint,
	);
	if (state.sessionApprovals.has(key)) return skill;
	const ticket = state.modelTickets.get(toolCallId);
	if (ticket) {
		state.modelTickets.delete(toolCallId);
		if (ticketMatches(ticket, skill, snapshot)) return skill;
		throw new LazySkillError("SKILL_APPROVAL_REQUIRED", {
			requestedName: skill.name,
		});
	}
	await authorizeAsk(skill, snapshot, state, ctx);
	return skill;
}

export function assertLiveSkillAccess(
	live: SkillSnapshot | undefined,
	captured: SkillSnapshot,
	name: string,
	modelInvocation: boolean,
): RuntimeSkill {
	if (!live) throw new LazySkillError("POLICY_INVALID");
	if (!live.policy.valid) throw new LazySkillError("POLICY_INVALID");
	if (live.policy.decision(name) === "deny") {
		throw new LazySkillError("SKILL_DENIED", { requestedName: name });
	}
	return policySkill(captured, name, modelInvocation);
}

export async function authorizeExplicitInvocation(
	invocation: ExplicitSkillInvocation,
	ctx: ExtensionContext,
	snapshot: SkillSnapshot | undefined,
	state: SkillAuthorizationState,
): Promise<RuntimeSkill> {
	if (!snapshot) throw new LazySkillError("POLICY_INVALID");
	const skill = policySkill(snapshot, invocation.name, false);
	const approval = await authorizeAsk(skill, snapshot, state, ctx);
	if (approval === "once") {
		state.explicitTickets.push({
			...ticketFor(skill, snapshot),
			args: invocation.args.trim(),
			createdAt: Date.now(),
		});
	}
	return skill;
}

function userMessageText(
	message: ContextEvent["messages"][number],
): string | undefined {
	if (message.role !== "user") return undefined;
	if (typeof message.content === "string") return message.content;
	const [first, ...rest] = message.content;
	if (
		!first ||
		first.type !== "text" ||
		rest.some((block) => block.type !== "image")
	) {
		return undefined;
	}
	return first.text;
}

function replaceUserMessageText(
	message: ContextEvent["messages"][number],
	text: string,
): ContextEvent["messages"][number] {
	if (message.role !== "user") return message;
	if (typeof message.content === "string") return { ...message, content: text };
	const [, ...rest] = message.content;
	return { ...message, content: [{ type: "text", text }, ...rest] };
}

interface MessageIdentity {
	readonly primary: string;
	readonly fallback: string;
}

function contextMessageIdentities(
	messages: readonly ContextEvent["messages"][number][],
	ctx: ExtensionContext,
): MessageIdentity[] {
	const entries = ctx.sessionManager.getEntries();
	const usedEntryIds = new Set<string>();
	return messages.map((message, index) => {
		const text = userMessageText(message) ?? "";
		const fallback = `fallback:${message.timestamp}:${hash(text)}:${index}`;
		if (message.role !== "user") return { primary: fallback, fallback };
		const entry = entries.find(
			(candidate) =>
				candidate.type === "message" &&
				!usedEntryIds.has(candidate.id) &&
				candidate.message.role === "user" &&
				candidate.message.timestamp === message.timestamp &&
				userMessageText(candidate.message) === text,
		);
		if (!entry) return { primary: fallback, fallback };
		usedEntryIds.add(entry.id);
		return { primary: `entry:${entry.id}`, fallback };
	});
}

function sameBinding(left: AuthorizedBlock, right: AuthorizedBlock): boolean {
	return (
		left.name === right.name &&
		left.canonicalPath === right.canonicalPath &&
		left.policyFingerprint === right.policyFingerprint &&
		left.bodyFingerprint === right.bodyFingerprint &&
		left.messageFingerprint === right.messageFingerprint
	);
}

function saveBinding(
	state: SkillAuthorizationState,
	identity: MessageIdentity,
	binding: AuthorizedBlock,
): void {
	state.authorizedBlocks.set(identity.primary, binding);
	state.authorizedBlocks.set(identity.fallback, binding);
}

function contextFailureCode(error: unknown): LazySkillErrorCode {
	return error instanceof LazySkillError ? error.code : "SKILL_UNREADABLE";
}

function contextFailure(code: LazySkillErrorCode): string {
	return new LazySkillError(code).message;
}

function matchingExplicitTicket(
	state: SkillAuthorizationState,
	skill: RuntimeSkill,
	snapshot: SkillSnapshot,
	args: string,
	messageTimestamp: number,
): number {
	return state.explicitTickets.findIndex(
		(ticket) =>
			ticketMatches(ticket, skill, snapshot) &&
			ticket.args === args &&
			ticket.createdAt <= messageTimestamp,
	);
}

/** Guard exact, whole-message Pi skill expansions immediately before provider context. */
export async function guardSkillContext(
	event: ContextEvent,
	ctx: ExtensionContext,
	snapshot: SkillSnapshot | undefined,
	state: SkillAuthorizationState,
): Promise<{ messages: ContextEvent["messages"] } | undefined> {
	const messages = pruneRoutingHintMessages([...event.messages]);
	const identities = contextMessageIdentities(messages, ctx);
	const bodyReads = new Map<string, ReturnType<typeof readValidatedSkillBody>>();
	let changed = messages.length !== event.messages.length;

	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (!message) continue;
		const text = userMessageText(message);
		if (text === undefined) continue;
		const parsed = parseSkillBlock(text);
		if (!parsed) continue;

		let failure: LazySkillErrorCode | undefined;
		const skill = snapshot?.byName.get(parsed.name);
		if (!snapshot || !snapshot.policy.valid) failure = "POLICY_INVALID";
		else if (!skill) failure = "SKILL_NOT_FOUND";
		else if (
			canonicalComparisonPath(parsed.location) !==
			canonicalComparisonPath(skill.filePath)
		) {
			failure = "SKILL_NOT_FOUND";
		} else if (snapshot.policy.decision(skill.name) === "deny") {
			failure = "SKILL_DENIED";
		}

		let binding: AuthorizedBlock | undefined;
		if (!failure && skill && snapshot) {
			try {
				let pending = bodyReads.get(skill.filePath);
				if (!pending) {
					pending = readValidatedSkillBody(
						skill,
						snapshot.config.maxSourceBytes,
						ctx.signal,
						true,
					);
					bodyReads.set(skill.filePath, pending);
				}
				const validated = await pending;
				const expected = `References are relative to ${skill.baseDir}.\n\n${validated.body}`;
				if (parsed.content === expected) {
					binding = {
						...ticketFor(skill, snapshot),
						bodyFingerprint: hash(validated.body),
						messageFingerprint: hash(text),
					};
				} else {
					failure = "SKILL_UNREADABLE";
				}
			} catch (error) {
				failure = contextFailureCode(error);
			}
		}

		const identity = identities[index];
		if (!identity) continue;
		if (!failure && binding && skill && snapshot) {
			const existing =
				state.authorizedBlocks.get(identity.primary) ??
				state.authorizedBlocks.get(identity.fallback);
			if (existing && sameBinding(existing, binding)) {
				saveBinding(state, identity, binding);
				continue;
			}
			const decision = snapshot.policy.decision(skill.name);
			const key = approvalKey(
				skill.name,
				canonicalComparisonPath(skill.filePath),
				snapshot.policy.fingerprint,
			);
			if (decision === "allow" || state.sessionApprovals.has(key)) {
				saveBinding(state, identity, binding);
				continue;
			}
			const ticketIndex = matchingExplicitTicket(
				state,
				skill,
				snapshot,
				parsed.userMessage?.trim() ?? "",
				message.timestamp,
			);
			if (ticketIndex !== -1) {
				state.explicitTickets.splice(ticketIndex, 1);
				saveBinding(state, identity, binding);
				continue;
			}
			failure = "SKILL_APPROVAL_REQUIRED";
		}

		state.authorizedBlocks.delete(identity.primary);
		state.authorizedBlocks.delete(identity.fallback);
		messages[index] = replaceUserMessageText(
			message,
			contextFailure(failure ?? "SKILL_UNREADABLE"),
		);
		changed = true;
	}
	return changed ? { messages } : undefined;
}

export function parseExplicitSkillInvocation(
	text: string,
): ExplicitSkillInvocation | undefined {
	let prefix: ExplicitSkillInvocation["prefix"];
	let start: number;
	if (text.startsWith("/lazy-skill:")) {
		prefix = "lazy-skill";
		start = "/lazy-skill:".length;
	} else if (text.startsWith("/skill:")) {
		prefix = "skill";
		start = "/skill:".length;
	} else {
		return undefined;
	}
	const separator = text.indexOf(" ", start);
	return {
		prefix,
		name: separator === -1 ? text.slice(start) : text.slice(start, separator),
		args: separator === -1 ? "" : text.slice(separator + 1),
	};
}

export function forwardedNativeSkillCommand(
	invocation: ExplicitSkillInvocation,
): string {
	return `/skill:${invocation.name}${invocation.args.length > 0 ? ` ${invocation.args}` : ""}`;
}

export function transformAuthorizedInput(
	event: InputEvent,
	invocation: ExplicitSkillInvocation,
):
	| { action: "continue" }
	| { action: "transform"; text: string; images?: InputEvent["images"] } {
	if (invocation.prefix === "skill") return { action: "continue" };
	return {
		action: "transform",
		text: forwardedNativeSkillCommand(invocation),
		...(event.images === undefined ? {} : { images: event.images }),
	};
}
