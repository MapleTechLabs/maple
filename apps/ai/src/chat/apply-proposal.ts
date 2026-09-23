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
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import {
	connectorApprovalTenant,
	decidedBy,
	orgIdFromChatSessionId,
	type ChatProposalApproval,
} from "@maple/domain/chat-session"
import { OrgId } from "@maple/domain/primitives"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { withPgConnectionScope } from "@maple/backend/platform/pg-connection-scope"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"
import { OrgMembershipService } from "@maple/backend/services/auth/OrgMembershipService"
import { workerEnvLayer } from "@maple/infra/worker-runtime"
import { workerTelemetryConfig } from "@maple/infra/worker-telemetry"
import { Cause, Effect, Layer, ManagedRuntime, Option, Schema } from "effect"
import { MCP_ANTICIPATED_ERROR_IDENTIFIERS } from "../mcp/expected-failures"
import { MUTATING_TOOL_NAMES } from "../mcp/tools/mutating"
import { toTenantContext, withConnectorActor } from "./turn-actor"

/** Its own instance, at module scope, so an approval exports its spans from the isolate it ran in. */
const telemetry = MapleCloudflareSDK.make(
	workerTelemetryConfig({
		serviceName: "maple-chat",
		anticipatedErrorIdentifiers: MCP_ANTICIPATED_ERROR_IDENTIFIERS,
	}),
)

export type ApplyChatProposalInput = ChatProposalApproval & {
	readonly env: Record<string, unknown>
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

/**
 * Nobody is linked, and nothing can be found out — the two are different and both refuse.
 *
 * Fail closed on purpose: a Clerk blip must not silently downgrade an approval to the org-level
 * identity, which carries `org:admin`.
 */
class ApproverNotPermitted extends Schema.TaggedError<ApproverNotPermitted>()(
	"@maple/ai/ApproverNotPermitted",
	{
		message: Schema.String,
		/** Which of the two it was — they read the same to the clicker and not to an operator. */
		reason: Schema.Literals(["not_a_member", "unavailable"]),
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

/**
 * Who the change runs as — which the caller decided before the session was ever reached. A person
 * in the app acts as themselves; see `ChatConnector.identity` for the connector cases.
 *
 * The linked user's roles come from the membership directory at approval time, not frozen at link
 * time. That read is cached (a per-isolate memo, then a shared tier), so a demotion lands within
 * the cache's revocation window rather than instantly; the membership webhook closes it from the
 * other side.
 */
export const resolveTenant = Effect.fnUntraced(function* (orgId: OrgId, input: ApplyChatProposalInput) {
	// The route authenticated them and resolved their roles; the audit entry names them.
	if ("tenant" in input) {
		yield* Effect.annotateCurrentSpan("maple.chat.apply.as", "app")
		return toTenantContext(input.tenant, input.approver)
	}
	if (input.actingUserId === undefined) {
		// What attributes the audit entry: the actor is the connector's agent, and the approver's
		// platform identity is the forensic context an auditor asks for.
		const tenant = toTenantContext(connectorApprovalTenant(orgId), input.approver)
		yield* Effect.annotateCurrentSpan("maple.chat.apply.as", "connector")
		// The same pinned agent actor a connector TURN runs as, so the change and the conversation
		// that proposed it are attributed to one identity.
		return yield* withConnectorActor(tenant, input.approver)
	}

	const memberships = yield* OrgMembershipService
	const membership = yield* memberships.verify(input.actingUserId, orgId).pipe(
		Effect.mapError(
			(cause) =>
				new ApproverNotPermitted({
					reason: "unavailable",
					message: "Maple could not check whether you are still a member of this organization.",
					cause,
				}),
		),
	)
	if (Option.isNone(membership)) {
		return yield* new ApproverNotPermitted({
			reason: "not_a_member",
			message: "The Maple account this chat account is linked to is no longer in this organization.",
		})
	}
	yield* Effect.annotateCurrentSpan("maple.chat.apply.as", "user")
	// No `actorId`: a real user acted, so the audit log names them rather than the connector's
	// agent. `turnOrigin` still rides along, which is what records WHICH chat account it was.
	return {
		orgId,
		userId: input.actingUserId,
		roles: [membership.value.role],
		authMode: "self_hosted" as const,
		turnOrigin: input.approver,
	} satisfies TenantContext
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
	// to hold. `connectorApprovalTenant` below grants `org:admin`, so this is the last thing between
	// an entry in a session's own log and an org-admin execution — which is why it answers here,
	// ahead of a runtime whose layers can die on a misconfigured environment, rather than from
	// inside one.
	if (!MUTATING_TOOL_NAMES.has(input.tool)) {
		return failure(`"${input.tool}" is not a change Maple applies from an approval.`)
	}

	// `ErrorActorsService` is deliberately absent: `./turn-actor` already puts it in this module's
	// static graph, so deferring it would only re-resolve a module that is loaded anyway.
	const [{ ChatApplyServicesLive }, { layerPg }, { mapleDbConnectionLayer }, { McpToolExecutor }] =
		await Promise.all([
			import("../runtime/mcp-service-graph"),
			import("@maple/backend/platform/DatabasePgLive"),
			import("@maple/backend/platform/pg-connection-source"),
			import("../mcp/dispatcher"),
		])

	const runtime = ManagedRuntime.make(
		ChatApplyServicesLive.pipe(
			Layer.provideMerge(layerPg),
			Layer.provideMerge(mapleDbConnectionLayer(input.env)),
			Layer.provideMerge(workerEnvLayer(input.env)),
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
		Effect.catchTag("@maple/ai/ApproverNotPermitted", (refusal) =>
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

	try {
		return await runtime.runPromise(program)
	} finally {
		await runtime.dispose().catch(() => undefined)
		await telemetry.flush(input.env).catch(() => undefined)
	}
}
