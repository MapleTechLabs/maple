/**
 * Running a mutation somebody approved, inside the `ChatSession` Durable Object.
 *
 * The heavy half of `ChatSession.settleProposal`, reached through a dynamic import for the same
 * reason `turn-runner` is: it builds the MCP service graph, which is hundreds of Schema ASTs at
 * module scope on a class the worker entry exports (Cloudflare error 10021).
 *
 * The one way an approved mutation runs, whether the click came from the web app
 * (`POST /internal/chat/apply`) or a chat platform: refuse a tool that is not approval-gated, run it
 * as a Maple user, and hand back what it said. See `ChatConnector.identity` for the connector half
 * of the approval policy; a connector approver's chat account rides along as forensic context on
 * the audit entry.
 */
import {
	chatSessionKind,
	decidedBy,
	orgIdFromChatSessionId,
	type ChatConnectorOrigin,
	type ChatProposalApproval,
} from "@maple/domain/chat-session"
import { OrgId, UserId } from "@maple/primitives"
import * as Policy from "@maple/domain/policy"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { withPgConnectionScope } from "@maple/backend/platform/pg-connection-scope"
import { Cause, Effect, Layer, ManagedRuntime, Option, Schema, Array as Arr } from "effect"
import { approvalPermission } from "./approval-permission"
import { canonicalToolName } from "../mcp/tools/tool-name-aliases"
import { chatPlatformLayer, type ChatRuntimeInput, chatTelemetry, releaseChatRuntime } from "./do-runtime"
import { LinkedUserNotPermitted, linkedUserTenant, toTenantContext } from "./turn-actor"

/**
 * An approval as it arrives over RPC, where nothing decoded it: a connector's acting user is a
 * claim to check here, not a brand to trust, and a relay build from before the rule sends none.
 */
type ReceivedApproval =
	| Extract<ChatProposalApproval, { readonly tenant: unknown }>
	| { readonly approver: ChatConnectorOrigin; readonly actingUserId?: string }

export type ApplyChatProposalInput = ReceivedApproval &
	ChatRuntimeInput & {
		/** `"<orgId>:<tabId>"` — the org the change is made in. */
		readonly sessionId: string
		/** The tool and arguments the session read out of its own log, never off the wire. */
		readonly tool: string
		readonly input: unknown
	}

export interface AppliedProposal {
	/** What the conversation records as this call's `tool-result`, and what the channel shows. */
	readonly output: string
	readonly isError: boolean
}

const failure = (output: string): AppliedProposal => ({ output, isError: true })

/**
 * What to say when the tool may or may not have run.
 *
 * A cause can be raised after `execute` has already changed something, so the copy for one must
 * not claim the change did not happen — the same hedge the session's own fallback makes.
 */
const UNCERTAIN = "Maple couldn't confirm the change went through — check it in Maple."

const decodeOrgId = Schema.decodeUnknownOption(OrgId)
const decodeUserId = Schema.decodeUnknownOption(UserId)

/** What a clicker nobody can name is told: nothing was applied, and where a change is made. */
const NOT_LINKED = "Maple could not tell which Maple user approved this. Make the change in the Maple app."

/** The Maple user a connector approval runs as, when the click named one that decodes. */
const actingUser = (input: Extract<ApplyChatProposalInput, { readonly actingUserId?: string }>) =>
	decodeUserId(input.actingUserId)

/**
 * Who the change runs as, which the caller decided before the session was ever reached: always a
 * Maple user holding what approving the tool needs (`approvalPermission`). A person in the app acts
 * as themselves, and a connector approver as the user their chat account is linked to (see
 * `ChatConnector.identity`).
 */
export const resolveTenant = Effect.fnUntraced(function* (orgId: OrgId, input: ApplyChatProposalInput) {
	const tenant = yield* approverTenant(orgId, input)
	yield* Policy.check(
		tenant.permissions,
		approvalPermission(input.tool),
		(denial) => new LinkedUserNotPermitted({ reason: "not_permitted", message: denial.message }),
	)
	return tenant
})

const approverTenant = Effect.fnUntraced(function* (orgId: OrgId, input: ApplyChatProposalInput) {
	// The route authenticated them and resolved their permissions; the audit entry names them.
	if ("tenant" in input) {
		yield* Effect.annotateCurrentSpan("maple.chat.apply.as", "app")
		return toTenantContext(input.tenant, input.approver)
	}
	const userId = actingUser(input)
	// `applyChatProposal` already refused this; held here too so this function cannot be reached
	// around it with nobody to act as.
	if (Option.isNone(userId)) {
		return yield* new LinkedUserNotPermitted({ reason: "not_linked", message: NOT_LINKED })
	}
	const tenant = yield* linkedUserTenant(orgId, userId.value, input.approver)
	yield* Effect.annotateCurrentSpan("maple.chat.apply.as", "user")
	return tenant
})

/**
 * Apply one approved proposal and answer with what to record.
 *
 * A failure inside the program comes back as an error result rather than a rejected promise: the
 * caller has to settle the proposal either way, and "the tool refused" and "the tool could not be
 * reached" read the same to somebody in a channel. Two things still reject — an interrupt, which
 * must stay one, and a layer that dies while the runtime is being built — and the caller settles
 * those with its own copy.
 */
export const applyChatProposal = async (input: ApplyChatProposalInput): Promise<AppliedProposal> => {
	// The org comes from the session's own name, never from the caller — the same rule every other
	// reader of a session id follows.
	const org = decodeOrgId(orgIdFromChatSessionId(input.sessionId))
	if (Option.isNone(org)) return failure("This conversation does not name an organization.")
	const orgId = org.value
	// The route checks this too; a caller's tenant never acts in another org's conversation.
	if ("tenant" in input && input.tenant.orgId !== orgId) {
		return failure("This conversation belongs to another organization.")
	}

	// Defense in depth: only an approval-gated mutation is applicable here, whatever the log happens
	// to hold. It answers here, ahead of a runtime whose layers can die on a misconfigured
	// environment, rather than from inside one.
	// Loaded here, not with this module: the set is derived from the tool registry, which the agent
	// records (read for the surface below) depend on too.
	const [{ MUTATING_TOOL_NAMES }, { agentForSession }, { toolSurfaceForApproval }] = await Promise.all([
		import("./permissions"),
		import("./agents"),
		import("./profiles"),
	])
	// A proposal made under a name since retired is still the change its replacement applies.
	if (!MUTATING_TOOL_NAMES.has(canonicalToolName(input.tool))) {
		return failure(`"${input.tool}" is not a change Maple applies from an approval.`)
	}
	// A change is only ever applied as a Maple user: a click that names none stops here, before a
	// runtime or a database connection exists.
	if (!("tenant" in input) && Option.isNone(actingUser(input))) return failure(NOT_LINKED)

	// `ErrorActorsService` is deliberately absent: `./turn-actor` already puts it in this module's
	// static graph, so deferring it would only re-resolve a module that is loaded anyway.
	const [{ ChatApplyServicesLive }, platform, { McpToolExecutor }] = await Promise.all([
		import("../runtime/mcp-service-graph"),
		chatPlatformLayer(input, chatTelemetry.layer),
		import("../mcp/dispatcher"),
	])

	const runtime = ManagedRuntime.make(ChatApplyServicesLive.pipe(Layer.provideMerge(platform)))

	const { approver } = input
	const by = decidedBy(approver)
	const connector = approver.kind === "connector" ? { "maple.chat.connector": approver.connectorId } : {}

	const program = Effect.gen(function* () {
		const executor = yield* McpToolExecutor
		const resolved = yield* resolveTenant(orgId, input)
		const tenant = { ...resolved, chatMode: chatSessionKind(input.sessionId).mode }
		const result = yield* executor.execute(
			tenant,
			input.tool,
			input.input,
			toolSurfaceForApproval(agentForSession(input.sessionId), input),
		)
		const content = Arr.join(
			Arr.map(result.content, (entry) => entry.text),
			"\n",
		)
		const refused = result.isError === true
		yield* Effect.annotateCurrentSpan("maple.chat.apply", refused ? "refused" : "applied")
		return {
			output: refused
				? `Approved ${by}, but it did not go through.\n${content}`
				: `Approved ${by}.\n${content}`,
			isError: refused,
		}
	}).pipe(
		// One Postgres pool for the whole apply — the actor lookup, the tool and its audit entry are
		// three `execute` calls, and without a scope each one dials its own.
		withPgConnectionScope,
		// The span is INSIDE the catch, so an apply that blew up closes as a failed span rather than
		// as a clean one wrapping a recovered value. Same order `turn-runner` uses.
		Effect.withSpan("chat.apply_proposal", {
			attributes: {
				orgId,
				"maple.chat.session": input.sessionId,
				"maple.mcp.tool": input.tool,
				...connector,
			},
		}),
		// The tool never ran on this one, so the hedged copy below would be wrong twice over — and
		// its own message is the only thing that tells the clicker what to do about it.
		Effect.catchTag("@maple/ai/LinkedUserNotPermitted", (refusal) =>
			Effect.annotateCurrentSpan("maple.chat.apply", `refused_${refusal.reason}`).pipe(
				Effect.as(failure(refusal.message)),
			),
		),
		Effect.catchCause((cause) =>
			// Interrupts stay interrupts, as everywhere else that swallows a cause here. Letting one
			// out is what the caller needs: it settles the proposal with copy that does NOT claim the
			// change was attempted and lost, because an interrupt mid-execute may have mutated.
			Cause.hasInterruptsOnly(cause)
				? Effect.interrupt
				: Effect.logError("A chat approval could not be applied").pipe(
						Effect.annotateLogs({
							orgId,
							"maple.mcp.tool": input.tool,
							...connector,
							"error.type": summarizeCause(cause),
						}),
						// Hedged rather than assertive: the cause may have been raised after the tool
						// already changed something, so this must not say the change did not happen.
						Effect.as(failure(`Approved ${by}. ${UNCERTAIN}`)),
					),
		),
	)

	// The outcome (an interrupt included, which the session settles with its own copy) is replayed
	// after the runtime is disposed and the spans flushed, both best effort.
	return Effect.runPromise(
		Effect.promise(() => runtime.runPromiseExit(program)).pipe(
			Effect.ensuring(releaseChatRuntime(runtime, input.env)),
			Effect.flatten,
		),
	)
}
