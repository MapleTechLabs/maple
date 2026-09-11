/** The API owns the turn slot, durable transcript, tool authorization and billing. */
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { MCP_ANTICIPATED_ERROR_IDENTIFIERS } from "@/mcp/expected-failures"
import { decodeChatTurnTenant, type ChatTurnTenantEncoded } from "@maple/domain/chat-session"
import { workerEnvLayer } from "@maple/infra/worker-runtime"
import { workerTelemetryConfig } from "@maple/infra/worker-telemetry"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import type { ChatSession } from "./ChatSession"
import { makeRunUsage, AiRunUsage, AiServiceError } from "@maple/domain/ai-service"
import { aiService, aiTools, toolCallbacks } from "@/ai/client"
import { SubmitDiagnosisRequest } from "@maple/domain/http"
import { decodeChatEventPayload, ChatMessage } from "@maple/domain/chat-session"

/**
 * Low-cardinality facts collected during the run and emitted once on the turn span.
 *
 * Mutable because the run discovers its outcome after the caller has already created the span.
 */
interface TurnObservability {
	outcome?: "stop" | "aborted" | "error" | "max-steps" | "unknown"
	failureReason?: string
}

const makeTurnObservability = (): TurnObservability => ({})
import type { TenantContext } from "@/services/auth/tenant-context"
import { summarizeCause } from "@/platform/describe-cause"
import { trackTokenUsage } from "@/services/billing/autumn-tracker"
import { investigationIdForSession } from "@maple/domain/ai-investigation-context"

// Deliberately not `maple-api`: background work sharing the request-facing
// service's name skewed its percentiles (p99 32s, 2026-09-04).
const telemetry = MapleCloudflareSDK.make(
	workerTelemetryConfig({
		serviceName: "maple-chat",
		anticipatedErrorIdentifiers: MCP_ANTICIPATED_ERROR_IDENTIFIERS,
	}),
)

export interface RunChatSessionTurnInput {
	/** The Durable Object itself. Appends are direct calls, not stub RPC. */
	readonly session: ChatSession
	readonly sessionId: string
	readonly env: Record<string, unknown>
	readonly messageId: string
	readonly tenant: ChatTurnTenantEncoded
}

/**
 * Decode the wire projection back into the `apps/api` tenant type.
 *
 * The Durable Object receives a plain, structured-cloneable object (RPC refuses class instances),
 * so the brands have to be re-established on this side before the value is used as a
 * `TenantContext`.
 */
const toTenantContext = (encoded: ChatTurnTenantEncoded): TenantContext => {
	const tenant = decodeChatTurnTenant(encoded)
	return {
		orgId: tenant.orgId,
		userId: tenant.userId,
		roles: [...tenant.roles],
		authMode: tenant.authMode,
		...(!(tenant.actorId === undefined) ? { actorId: tenant.actorId } : undefined),
	}
}

/**
 * Metering is housekeeping, and it runs after the answer, on the way out of the turn.
 *
 * `endTurn` sits in the `finally` of `ChatSession.runTurn`, so whatever the metering finalizer
 * waits on holds the session's turn slot, and the stale-claim reclaim is 15 minutes out
 * (`TURN_STALE_MS` in `ChatSession.ts`). Unbounded, a POST to Autumn that never answers is a way
 * for a third party's outage to wedge a conversation.
 *
 * On timeout the request is abandoned rather than aborted: it may still land, and if it does not,
 * one turn goes unbilled. That is the trade the tracker already makes for a failed request.
 */
const METERING_TIMEOUT = "5 seconds"

/** Stable copy for the durable/browser event; detailed causes stay server-side. */
const CHAT_TURN_FAILED = "Maple couldn't complete this response."

/**
 * Meter what this turn spent into the org's AI usage, alongside the fan-out workflow's triage
 * passes and the Slack agent.
 *
 * **One meter per turn, and this is it.** Two things used to bill the same tokens from different
 * angles: `submit_diagnosis` billed the running total it reports to `InvestigationService`, keyed
 * on the bare investigation id, so an investigation was charged exactly once however much it went
 * on to cost — every follow-up turn was free, and so was any turn that errored or ran out of steps
 * before reaching the tool. Suppressing this one in its favour lost the charge entirely, because a
 * superseding diagnosis deduplicates against the first. So the investigation still records its
 * tokens on the row, and this bills them, once, per turn.
 *
 * **Source and key follow the session.** An investigation session bills as `triage`, keyed
 * `<investigationId>:turn-<messageId>` — the `turn-` prefix keeps the key space disjoint from the
 * fan-out's `<id>:<attempt>` under that same source, where an unprefixed turn id could collide
 * with an attempt number and silently swallow a real charge. Every other session is an attended
 * chat turn and bills as `chat`, keyed `<sessionId>:<messageId>`. Either way the key carries the
 * turn, so a turn that somehow ran twice still meters once, and a restarted investigation's new
 * turn is real new spend that bills.
 *
 * `usage` is the turn's whole total: every step, every sub-agent (they share the parent's
 * accumulator), and the compaction that runs after the answer.
 *
 * **In a finalizer, not on the happy path.** A turn that failed, was stopped, or ran out of steps
 * is still billed for every step the provider actually served — the loop accounts a step's usage
 * before it checks whether the turn survived. Metering follows the spend, not the outcome. (A step
 * interrupted before the provider's terminal event reports no usage at all, so that much is
 * unbillable rather than unbilled.)
 */
export const meterTurn = (
	input: Pick<RunChatSessionTurnInput, "sessionId" | "messageId" | "env">,
	tenant: Pick<TenantContext, "orgId">,
	usage: { readonly input: number; readonly output: number },
): Effect.Effect<void> => {
	if (usage.input <= 0 && usage.output <= 0) return Effect.void
	const billing = investigationBilling(input.sessionId, input.messageId) ?? {
		source: "chat" as const,
		idempotencyKey: `${input.sessionId}:${input.messageId}`,
	}
	// Bookkeeping must never fail a delivered answer. `trackTokenUsage` already swallows its own
	// transport errors; the `catch` covers the rest so this can be an infallible Effect.
	return Effect.promise(() =>
		trackTokenUsage(input.env, {
			orgId: tenant.orgId,
			inputTokens: usage.input,
			outputTokens: usage.output,
			idempotencyKey: billing.idempotencyKey,
			source: billing.source,
		}).catch(() => undefined),
	).pipe(Effect.timeout(METERING_TIMEOUT), Effect.ignore)
}

/**
 * `triage` billing coordinates for an investigation session, or `undefined` if this is not one.
 *
 * The address decoder is shared with report submission, so the set of
 * sessions that bill as triage is exactly the set that gets a `submit_diagnosis` tool: an `inv-`
 * suffix that is not a UUID is not an investigation, and must not be charged as one. It still
 * bills — as the plain chat turn it is.
 */
const investigationBilling = (
	sessionId: string,
	messageId: string,
): { readonly source: "triage"; readonly idempotencyKey: string } | undefined => {
	const investigationId = investigationIdForSession(sessionId)
	return investigationId === undefined
		? undefined
		: { source: "triage", idempotencyKey: `${investigationId}:turn-${messageId}` }
}

/**
 * Drive one turn to completion.
 *
 * Resolves as a promise because the caller is a Durable Object method, not an Effect. Failures are
 * recorded into the log as a terminal event rather than propagated: the log is the only thing the
 * client reads, so a turn that dies without one is indistinguishable from a turn that hung.
 */
export const runChatSessionTurn = async (input: RunChatSessionTurnInput): Promise<void> => {
	const [
		{ InvestigationServicesLive },
		{ layerPg },
		{ mapleDbConnectionLayer },

		{ McpToolExecutor },
	] = await Promise.all([
		import("../runtime/mcp-service-graph"),
		import("../platform/DatabasePgLive"),
		import("../platform/pg-connection-source"),

		import("../mcp/dispatcher"),
	])
	const { InvestigationService } = await import("@/services/errors/InvestigationService")

	const runtime = ManagedRuntime.make(
		InvestigationServicesLive.pipe(
			Layer.provideMerge(layerPg),
			Layer.provideMerge(mapleDbConnectionLayer(input.env)),
			Layer.provideMerge(workerEnvLayer(input.env)),
			Layer.provideMerge(telemetry.layer),
		),
	)

	const tenant = toTenantContext(input.tenant)
	const observability = makeTurnObservability()
	// Hoisted out of the program: `submit_diagnosis` reads it mid-run — the tool is invoked mid-run
	// so there is no later moment to hand it a total — and the metering finalizer reads it after the
	// turn has ended, including when it ended by failing.
	const usage = makeRunUsage()
	let recordedTerminal = false
	// `empty_output` and `recovery_count` are gone with the machinery that produced them: they
	// counted the old loop's own repair attempts, and the engine has no equivalent to report.
	const annotateTurn = () =>
		Effect.annotateCurrentSpan({
			"maple.chat.outcome": observability.outcome ?? "unknown",
			...(observability.failureReason === undefined
				? undefined
				: { "maple.chat.failure_reason": observability.failureReason }),
		})

	const program = Effect.gen(function* () {
		const investigations = yield* InvestigationService
		const toolExecutor = yield* McpToolExecutor
		const history = input.session.history()

		// The session recorded the user's message before the run started, so the transcript's tail is
		// this run's input rather than part of its history.
		// Read once: it is a SQL scan plus a decode, and it is a read-only snapshot.
		const compaction = input.session.compaction()
		const spoken = history.filter((message) => message.text.trim() !== "")
		const latest = spoken.at(-1)
		const text = latest?.role === "user" ? latest.text : ""
		const prior = latest?.role === "user" ? spoken.slice(0, -1) : spoken

		const tools = yield* aiTools
		const callbacks = yield* toolCallbacks(toolExecutor, tenant, "chat", () =>
			input.session.holdsTurn(input.messageId),
		)
		const investigationId = investigationIdForSession(input.sessionId)
		const runCallback = Effect.runPromiseWith(yield* Effect.context<never>())
		yield* aiService(input.env).chat(
			{
				sessionId: input.sessionId,
				messageId: input.messageId,
				tenant: input.tenant,
				tools,
				text,
				history: prior.map((message) => Schema.encodeSync(ChatMessage)(message)),
				...(compaction === undefined ? undefined : { compaction }),
			},
			{
				...callbacks,
				submitDiagnosis: (raw) =>
					runCallback(
						Effect.gen(function* () {
							if (!input.session.holdsTurn(input.messageId) || investigationId === undefined) {
								return yield* Effect.fail(
									new AiServiceError({ message: "Investigation turn is no longer active" }),
								)
							}
							const request = yield* Schema.decodeUnknownEffect(SubmitDiagnosisRequest)(raw)
							yield* investigations.submitDiagnosis(tenant.orgId, investigationId, request)
						}),
					),
				publish: async (payloads, totals) => {
					Object.assign(usage, Schema.decodeUnknownSync(AiRunUsage)(totals))
					if (!input.session.holdsTurn(input.messageId)) return false
					for (const payload of payloads) {
						const { seq: _seq, ...event } = decodeChatEventPayload(payload, 0)
						if ("messageId" in event && event.messageId !== input.messageId) continue
						input.session.append(event)
						if (event.type === "turn-end" && event.task === undefined) {
							recordedTerminal = true
							observability.outcome = event.reason
						}
					}
					return input.session.holdsTurn(input.messageId)
				},
			},
		)

		if (!recordedTerminal && !input.session.holdsTurn(input.messageId)) {
			observability.outcome = "aborted"
		}
		yield* annotateTurn()
	}).pipe(
		// `ensuring`, not a trailing statement: a turn that failed, was aborted, or ran out of steps
		// still burned the tokens it burned, and the pre-`ensuring` shape billed none of them.
		Effect.ensuring(Effect.suspend(() => meterTurn(input, tenant, usage))),
		Effect.tapCause((cause) => {
			observability.outcome = "error"
			observability.failureReason ??= "UnhandledTurnFailure"
			return annotateTurn().pipe(
				Effect.andThen(
					Effect.logError("Unhandled chat turn failure").pipe(
						Effect.annotateLogs({
							sessionId: input.sessionId,
							messageId: input.messageId,
							cause: summarizeCause(cause),
						}),
					),
				),
			)
		}),
		Effect.withSpan("chat.turn", {
			attributes: {
				orgId: tenant.orgId,
				"maple.chat.session": input.sessionId,
				"maple.chat.message_id": input.messageId,
			},
		}),
	)

	try {
		await runtime.runPromise(program)
	} catch {
		// The detailed cause belongs in server logs and the failed Effect span, never in the durable
		// event the browser reads back.
		if (input.session.holdsTurn(input.messageId)) {
			input.session.append({
				type: "turn-end",
				messageId: input.messageId,
				reason: "error",
				error: CHAT_TURN_FAILED,
			})
		}
	} finally {
		await runtime.dispose().catch(() => undefined)
		await telemetry.flush(input.env).catch(() => undefined)
	}
}
