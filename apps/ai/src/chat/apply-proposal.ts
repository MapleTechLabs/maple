/**
 * Running a mutation somebody approved, inside the `ChatSession` Durable Object.
 *
 * The heavy half of `ChatSession.settleProposal`, reached through a dynamic import for the same
 * reason `turn-runner` is: it builds the MCP service graph, which is hundreds of Schema ASTs at
 * module scope on a class the worker entry exports (Cloudflare error 10021).
 *
 * The one way an approved mutation runs, whether the click came from the web app
 * (`POST /internal/chat/apply`) or a chat platform: refuse a tool that is not approval-gated, run it
 * under a resolved tenant, and hand back what it said. See `ChatConnector.identity` for the
 * connector half of the approval policy; a connector approver's chat account rides along as
 * forensic context on the audit entry.
 */
import { decidedBy, orgIdFromChatSessionId, type ChatProposalApproval } from "@maple/domain/chat-session"
import { OrgId, UserId } from "@maple/domain/primitives"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { withPgConnectionScope } from "@maple/backend/platform/pg-connection-scope"
import { type ChatSessionNamespace, chatSessionsLayerIfBound } from "@maple/backend/platform/chat-sessions"
import { envPorts } from "@maple/backend/platform/env-ports"
import { runtimeTelemetry } from "@maple/infra/worker-telemetry"
import { Cause, Effect, Layer, ManagedRuntime, Option, Schema } from "effect"
import { MCP_ANTICIPATED_ERROR_IDENTIFIERS } from "../mcp/expected-failures"
import { MUTATING_TOOL_NAMES } from "../mcp/tools/mutating"
import { linkedUserTenant, toTenantContext } from "./turn-actor"

/** Its own instance, at module scope, so an approval exports its spans from the isolate it ran in. */
const telemetry = runtimeTelemetry({
	serviceName: "maple-chat",
	anticipatedErrorIdentifiers: MCP_ANTICIPATED_ERROR_IDENTIFIERS,
})

export type ApplyChatProposalInput = ChatProposalApproval & {
	readonly env: Record<string, unknown>
	/** This Worker's `ChatSession` namespace, from the activation; the graph's `ChatSessions` port. */
	readonly chatSessions?: ChatSessionNamespace
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
const isUserId = Schema.is(UserId)

/** A connector approval with no linked Maple user behind it; there is no identity to run it as. */
export const LINK_REQUIRED =
	"Link your chat account to your Maple user to approve changes from here, or make this change in Maple."

/**
 * Who the change runs as, which the caller decided before the session was ever reached. A person
 * in the app acts as themselves; a connector approver acts as the Maple user their account links to.
 */
export const resolveTenant = Effect.fnUntraced(function* (orgId: OrgId, input: ApplyChatProposalInput) {
	// The route authenticated them and resolved their roles; the audit entry names them.
	if ("tenant" in input) {
		yield* Effect.annotateCurrentSpan("maple.chat.apply.as", "app")
		return toTenantContext(input.tenant, input.approver)
	}
	const tenant = yield* linkedUserTenant(orgId, input.actingUserId, input.approver)
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

	// The decision arrives undecoded over RPC, so an older caller without a linked user is refused
	// here rather than reaching a tenant lookup.
	if (!("tenant" in input) && !isUserId(input.actingUserId)) return failure(LINK_REQUIRED)

	// Defense in depth: only an approval-gated mutation is applicable here, whatever the log happens
	// to hold, and it answers ahead of a runtime whose layers can die on a misconfigured environment.
	if (!MUTATING_TOOL_NAMES.has(input.tool)) {
		return failure(`"${input.tool}" is not a change Maple applies from an approval.`)
	}

	// `ErrorActorsService` is deliberately absent: `./turn-actor` already puts it in this module's
	// static graph, so deferring it would only re-resolve a module that is loaded anyway.
	const [{ ChatApplyServicesLive }, { DatabasePgLive }, { layerMapleDbConnection }, { McpToolExecutor }] =
		await Promise.all([
			import("../runtime/mcp-service-graph"),
			import("@maple/backend/platform/DatabasePgLive"),
			import("@maple/backend/platform/pg-connection-source"),
			import("../mcp/dispatcher"),
		])

	const runtime = ManagedRuntime.make(
		ChatApplyServicesLive.pipe(
			Layer.provideMerge(DatabasePgLive),
			Layer.provideMerge(layerMapleDbConnection(input.env)),
			Layer.provideMerge(envPorts(input.env)),
			Layer.provideMerge(chatSessionsLayerIfBound(input.chatSessions, input.env)),
			Layer.provideMerge(telemetry.layer),
		),
	)

	const { approver } = input
	const by = decidedBy(approver)
	const connector = approver.kind === "connector" ? { "maple.chat.connector": approver.connectorId } : {}

	const program = Effect.gen(function* () {
		const executor = yield* McpToolExecutor
		const tenant = yield* resolveTenant(orgId, input)
		const surface = approver.kind === "app" ? "chat" : "bot"
		const result = yield* executor.execute(tenant, input.tool, input.input, surface)
		const content = result.content.map((entry) => entry.text).join("\n")
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
			Effect.ensuring(Effect.tryPromise(() => runtime.dispose()).pipe(Effect.ignore)),
			Effect.ensuring(Effect.tryPromise(() => telemetry.flush(input.env)).pipe(Effect.ignore)),
			Effect.flatMap((exit) => exit),
		),
	)
}
