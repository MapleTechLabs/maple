/**
 * Running a mutation somebody approved from a chat platform, inside the `ChatSession` Durable
 * Object.
 *
 * The heavy half of `ChatSession.settleProposal`, reached through a dynamic import for the same
 * reason `turn-runner` is: it builds the MCP service graph, which is hundreds of Schema ASTs at
 * module scope on a class the worker entry exports (Cloudflare error 10021).
 *
 * It is the connector's counterpart to `POST /internal/chat/apply`, which the web client uses, and
 * it does the same three things in the same order — refuse a tool that is not approval-gated, run
 * it under a resolved tenant, and hand back what it said. What differs is everything to do with
 * identity: the web caller is a signed-in person whose own roles the tool checks, while here the
 * person holds no Maple identity at all, so the connector's agent actor performs the change and
 * who approved it rides along as forensic context on the audit entry.
 */
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import {
	connectorApprovalTenant,
	decodeChatTurnTenant,
	orgIdFromChatSessionId,
	type ChatConnectorOrigin,
} from "@maple/domain/chat-session"
import { OrgId } from "@maple/domain/primitives"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"
import { workerEnvLayer } from "@maple/infra/worker-runtime"
import { workerTelemetryConfig } from "@maple/infra/worker-telemetry"
import { Effect, Layer, ManagedRuntime, Option, Schema } from "effect"
import { MCP_ANTICIPATED_ERROR_IDENTIFIERS } from "../mcp/expected-failures"
import { MUTATING_TOOL_NAMES } from "../mcp/tools/mutating"
import { withConnectorActor } from "./turn-actor"

/** Its own instance, at module scope, so an approval exports its spans from the isolate it ran in. */
const telemetry = MapleCloudflareSDK.make(
	workerTelemetryConfig({
		serviceName: "maple-chat",
		anticipatedErrorIdentifiers: MCP_ANTICIPATED_ERROR_IDENTIFIERS,
	}),
)

export interface ApplyChatProposalInput {
	readonly env: Record<string, unknown>
	/** `"<orgId>:<tabId>"` — the org the change is made in. */
	readonly sessionId: string
	readonly approver: ChatConnectorOrigin
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

const decodeOrgId = Schema.decodeUnknownOption(OrgId)

/**
 * Apply one approved proposal and answer with what to record.
 *
 * Every failure comes back as an error result rather than a rejected promise: the caller has to
 * settle the proposal either way, and "the tool refused" and "the tool could not be reached" read
 * the same to somebody in a channel.
 */
export const applyChatProposal = async (input: ApplyChatProposalInput): Promise<AppliedProposal> => {
	// The org comes from the session's own name, never from the caller — the same rule every other
	// reader of a session id follows.
	const org = decodeOrgId(orgIdFromChatSessionId(input.sessionId))
	if (Option.isNone(org)) return failure("This conversation does not name an organization.")
	const orgId = org.value

	// Defense in depth, exactly as the web apply path does it: only an approval-gated mutation is
	// applicable here, whatever the log happens to hold.
	if (!MUTATING_TOOL_NAMES.has(input.tool)) {
		return failure(`"${input.tool}" is not a change Maple applies from an approval.`)
	}

	const [{ McpServicesLive }, { layerPg }, { mapleDbConnectionLayer }, { McpToolExecutor }, actors] =
		await Promise.all([
			import("../runtime/mcp-service-graph"),
			import("@maple/backend/platform/DatabasePgLive"),
			import("@maple/backend/platform/pg-connection-source"),
			import("../mcp/dispatcher"),
			import("@maple/backend/services/errors/ErrorActorsService"),
		])

	const runtime = ManagedRuntime.make(
		Layer.mergeAll(McpServicesLive, actors.ErrorActorsService.layer).pipe(
			Layer.provideMerge(layerPg),
			Layer.provideMerge(mapleDbConnectionLayer(input.env)),
			Layer.provideMerge(workerEnvLayer(input.env)),
			Layer.provideMerge(telemetry.layer),
		),
	)

	// The role is the whole point of the apply path and is granted ONLY because the host Worker has
	// already matched the clicker against the workspace's configured approver role — see
	// `connectorApprovalTenant`. The turn that wrote this proposal carried no roles at all.
	const proposed = decodeChatTurnTenant(connectorApprovalTenant(orgId))
	const tenant: TenantContext = {
		orgId: proposed.orgId,
		userId: proposed.userId,
		roles: [...proposed.roles],
		authMode: proposed.authMode,
		// What attributes the audit entry: the actor is the connector's agent, and the approver's
		// platform identity is the forensic context an auditor asks for.
		turnOrigin: input.approver,
	}

	const program = Effect.gen(function* () {
		const executor = yield* McpToolExecutor
		// The same pinned agent actor a connector TURN runs as, so the change and the conversation
		// that proposed it are attributed to one identity.
		const acting = yield* withConnectorActor(tenant, input.approver)
		const result = yield* executor.execute(acting, input.tool, input.input, "bot")
		const content = result.content.map((entry) => entry.text).join("\n")
		return {
			output:
				result.isError === true
					? `Approved by ${input.approver.displayName}, but it did not go through.\n${content}`
					: `Approved by ${input.approver.displayName}.\n${content}`,
			isError: result.isError === true,
		}
	}).pipe(
		Effect.catchCause((cause) =>
			Effect.logError("A chat approval could not be applied").pipe(
				Effect.annotateLogs({
					orgId,
					tool: input.tool,
					connector: input.approver.connectorId,
					error: summarizeCause(cause),
				}),
				Effect.as(
					failure(`Approved by ${input.approver.displayName}, but Maple could not apply it.`),
				),
			),
		),
		Effect.withSpan("chat.apply_proposal", {
			attributes: {
				orgId,
				"maple.chat.session": input.sessionId,
				"maple.mcp.tool": input.tool,
				"maple.chat.connector": input.approver.connectorId,
			},
		}),
	)

	try {
		return await runtime.runPromise(program)
	} finally {
		await runtime.dispose().catch(() => undefined)
		await telemetry.flush(input.env).catch(() => undefined)
	}
}
