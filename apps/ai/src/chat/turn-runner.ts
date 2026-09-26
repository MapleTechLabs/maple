/**
 * Running one chat turn, inside the `ChatSession` Durable Object.
 *
 * This module is the heavy half of the DO: the Effect runtime, the app service graph and the agent
 * engine. `ChatSession.ts` reaches it through a dynamic import for the same reason
 * `worker.ts` dynamic-imports its route graph — the static graph builds hundreds of Schema ASTs at
 * module scope, which would blow Cloudflare's ~1s startup-CPU budget (error 10021) on a class that
 * is exported from the worker entry.
 *
 * Two things changed shape when the turn moved in here:
 *
 *   - **Appends are method calls.** The turn used to run in the request that submitted the message
 *     and write back over the DO stub, one RPC per token delta. It now holds the object itself.
 *   - **`submit_diagnosis` resolves itself.** It used to be threaded in as a callback from three
 *     call sites, because `InvestigationService` starting an investigation's own turn would have
 *     made the service require itself through the Effect requirements channel. Here the turn builds
 *     its *own* runtime, so it just resolves `InvestigationService` — no cycle, and no
 *     `env: workerEnv ?? {}` fallback silently degrading the model config when a caller forgot to
 *     thread the worker env through.
 */
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { MCP_ANTICIPATED_ERROR_IDENTIFIERS } from "../mcp/expected-failures"
import { ChatMessage, type ChatTurnOrigin, type ChatTurnTenantEncoded } from "@maple/domain/chat-session"
import type { InvestigationProgress, PrReviewFailureReason } from "@maple/domain/http"
import { workerEnvLayer } from "@maple/infra/worker-runtime"
import { workerTelemetryConfig } from "@maple/infra/worker-telemetry"
import { Cause, Effect, Layer, ManagedRuntime, Option } from "effect"
import type { ChatSession } from "./ChatSession"
import type { ChatTurnEvent } from "./events"
import { withToolTranscript } from "./close-out"
import { CLOSE_OUT_PROMPT, PR_REPLY_CLOSE_OUT_PROMPT, PR_REVIEW_CLOSE_OUT_PROMPT } from "./prompts"
import { makeProgressRecorder, parseToolInput } from "./progress"
import { makeReviewCoverage } from "./review-coverage"
import { reviewFailureError, reviewFailureReason } from "./review-failure"
import { makeReviewLedger } from "./review-ledger"
import {
	investigationForSession,
	isAutonomousTurn,
	makeRunUsage,
	prReplyForSession,
	prReviewForSession,
	savedFindingsRequest,
	SUBMIT_DIAGNOSIS,
} from "./tools"

/**
 * Low-cardinality facts collected during the run and emitted once on the turn span.
 *
 * Mutable because the run discovers its outcome after the caller has already created the span.
 */
interface TurnObservability {
	outcome?: "stop" | "aborted" | "error" | "max-steps" | "unknown"
	failureReason?: string
	/** Model-context compactions across the pass and its close-out; see `ChatRunOutcome`. */
	compactions?: number
}

const makeTurnObservability = (): TurnObservability => ({})
import { agentForSession } from "./agents"
import { profileForTurn } from "./profiles"
import { runChatTurn, type ChatRunOutcome } from "./run"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"
import { toTenantContext, withConnectorActor } from "./turn-actor"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { trackTokenUsage } from "@maple/backend/services/billing/autumn-tracker"

/**
 * The engine's per-step bookkeeping, which is named and therefore traced.
 *
 * Until effect-agent beta.104 this list also held `AgentRuntime.ownModelResponsePart`, one span per
 * streamed delta: 99.8% of this service's spans on 2026-09-18, evicting the run's real spans from
 * the SDK's 10,000-span buffer. Upstream removed it; these are the zero-content leftovers.
 *
 * Named one by one rather than by an `AgentRuntime.` prefix: `AgentRuntime.model` is the model
 * call, and `dropSpanNames` matches on prefix.
 */
const ENGINE_BOOKKEEPING_SPANS = [
	"AgentRuntime.estimateContextTokens",
	"AgentRuntime.nextContextEstimate",
	"AgentRuntime.decodeEventJson",
	"AgentRuntime.schedulingConcurrency",
	"ToolExposure.eligibleCatalog",
]

// Deliberately not `maple-api`: background work sharing the request-facing
// service's name skewed its percentiles (p99 32s, 2026-09-04).
const telemetry = MapleCloudflareSDK.make(
	workerTelemetryConfig({
		serviceName: "maple-chat",
		anticipatedErrorIdentifiers: MCP_ANTICIPATED_ERROR_IDENTIFIERS,
		dropSpanNames: ENGINE_BOOKKEEPING_SPANS,
	}),
)

export interface RunChatSessionTurnInput {
	/** The Durable Object itself. Appends are direct calls, not stub RPC. */
	readonly session: ChatSession
	readonly sessionId: string
	readonly env: Record<string, unknown>
	readonly messageId: string
	readonly tenant: ChatTurnTenantEncoded
	/** Who is driving the turn, stated by whoever raised it. */
	readonly origin: ChatTurnOrigin
}

/**
 * Metering is housekeeping, and it runs after the answer, on the way out of the turn.
 *
 * `endTurn` sits in the `finally` of `ChatSession.runTurn`, so whatever the metering finalizer
 * waits on holds the session's turn slot, and the stale-claim reclaim is tens of minutes out
 * (`TURN_STALE_MS` in `ChatSession.ts`). Unbounded, a POST to Autumn that never answers is a way
 * for a third party's outage to wedge a conversation.
 *
 * On timeout the request is abandoned rather than aborted: it may still land, and if it does not,
 * one turn goes unbilled. That is the trade the tracker already makes for a failed request.
 */
const METERING_TIMEOUT = "5 seconds"

/** Stable copy for the durable/browser event; detailed causes stay server-side. */
const CHAT_TURN_FAILED = "Maple couldn't complete this response."
const NO_DIAGNOSIS_MESSAGE = "Maple ended this investigation without a diagnosis."
/** What the row records when the pass and its close-out both ended in prose or on an error. */
const NO_DIAGNOSIS_ERROR = "no_diagnosis: the agent ended its pass without submitting a diagnosis; retry"
const NO_REVIEW_MESSAGE = "Maple ended this review without a report."
const NO_REPLY_MESSAGE = "Maple ended this answer without posting it."
const NO_REPLY_ERROR = "no_reply: the agent ended its pass without submitting an answer"

/**
 * Meter what this turn spent into the org's AI usage.
 *
 * **One meter per turn, and this is it.** Two things used to bill the same tokens from different
 * angles: `submit_diagnosis` billed the running total it reports to `InvestigationService`, keyed
 * on the bare investigation id, so an investigation was charged exactly once however much it went
 * on to cost: every follow-up turn was free, and so was any turn that errored or ran out of steps
 * before reaching the tool. Suppressing this one in its favour lost the charge entirely, because a
 * superseding diagnosis deduplicates against the first. So the investigation still records its
 * tokens on the row, and this bills them, once, per turn.
 *
 * **Source and key follow the session.** An investigation session bills as `triage`, keyed
 * `<investigationId>:turn-<messageId>`; every other session keys on `<sessionId>:<messageId>` and
 * bills under its origin's profile surface. The `turn-` prefix is kept: the deleted fan-out billed
 * `<id>:<attempt>` under this same source, and rows under those keys are still in Autumn, so an
 * unprefixed turn id could still collide with an old attempt number and swallow a real charge.
 * Either way the key carries the turn, so a turn that somehow ran twice still meters once, and a
 * restarted investigation's new turn is real new spend that bills.
 *
 * `usage` is the turn's whole total: every model call the run made, including any the engine spent
 * compacting, and any a sub-agent made against the parent's accumulator.
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
	origin: ChatTurnOrigin,
	usage: { readonly input: number; readonly output: number },
): Effect.Effect<void> => {
	if (usage.input <= 0 && usage.output <= 0) return Effect.void
	const billing = investigationBilling(input.sessionId, input.messageId) ??
		reviewBilling(input.sessionId, input.messageId) ?? {
			source: profileForTurn(agentForSession(input.sessionId), origin).surface,
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
 * The `InvestigationId` decode is the same guard `buildDiagnosisCompletion` uses, so the set of
 * sessions that bill as triage is exactly the set that gets a `submit_diagnosis` tool: an `inv-`
 * suffix that is not a UUID is not an investigation, and must not be charged as one. It still
 * bills — as the plain chat turn it is.
 */
const investigationBilling = (
	sessionId: string,
	messageId: string,
): { readonly source: "triage"; readonly idempotencyKey: string } | undefined => {
	const investigationId = investigationForSession(sessionId)
	if (investigationId === undefined) return undefined
	return { source: "triage", idempotencyKey: `${investigationId}:turn-${messageId}` }
}

/** A pull request review's turn bills as `review`, keyed on the review, like an investigation's. */
const reviewBilling = (
	sessionId: string,
	messageId: string,
): { readonly source: "review"; readonly idempotencyKey: string } | undefined => {
	const reviewId = prReviewForSession(sessionId) ?? prReplyForSession(sessionId)
	if (reviewId === undefined) return undefined
	return { source: "review", idempotencyKey: `${reviewId}:turn-${messageId}` }
}

/**
 * Drive one turn to completion.
 *
 * Resolves as a promise because the caller is a Durable Object method, not an Effect. Failures are
 * recorded into the log as a terminal event rather than propagated: the log is the only thing the
 * client reads, so a turn that dies without one is indistinguishable from a turn that hung.
 */
export const runChatSessionTurn = async (input: RunChatSessionTurnInput): Promise<void> => {
	const origin = input.origin

	const [
		{ InvestigationServicesLive },
		{ layerPg },
		{ mapleDbConnectionLayer },
		{ layerDecisionModel, layerFindingEmbedder, layerLlm, resolveReviewModel, resolveTriageModel },
		{ McpToolExecutor },
	] = await Promise.all([
		import("../runtime/mcp-service-graph"),
		import("@maple/backend/platform/DatabasePgLive"),
		import("@maple/backend/platform/pg-connection-source"),
		import("../platform/Llm"),
		import("../mcp/dispatcher"),
	])
	const { InvestigationService } = await import("@maple/backend/services/errors/InvestigationService")
	const { PrReviewService } = await import("@maple/backend/services/pr-review/PrReviewService")
	const { PrReviewConversationService } =
		await import("@maple/backend/services/pr-review/PrReviewConversationService")

	const runtime = ManagedRuntime.make(
		InvestigationServicesLive.pipe(
			// Decisions before the clients: `layerLlm` is what answers the OpenRouter
			// client the decision model runs on.
			Layer.provideMerge(layerDecisionModel(input.env)),
			// Read by `PrReviewService` as it is built: the review's feedback filter.
			Layer.provideMerge(layerFindingEmbedder(input.env)),
			Layer.provideMerge(layerLlm(input.env)),
			Layer.provideMerge(layerPg),
			Layer.provideMerge(mapleDbConnectionLayer(input.env)),
			Layer.provideMerge(workerEnvLayer(input.env)),
			Layer.provideMerge(telemetry.layer),
		),
	)

	const tenant = toTenantContext(input.tenant, origin)
	// One answer for the model's tags and the turn span, the same one the toolkit is built from.
	// `meterTurn` resolves its own because it runs as a finalizer and is separately exported.
	const surface = profileForTurn(agentForSession(input.sessionId), origin).surface
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
			...(observability.compactions === undefined
				? undefined
				: { "maple.chat.compactions": observability.compactions }),
			...(observability.failureReason === undefined
				? undefined
				: { "maple.chat.failure_reason": observability.failureReason }),
		})

	const investigationId = investigationForSession(input.sessionId)
	const prReviewId = prReviewForSession(input.sessionId)
	const prReplyId = prReplyForSession(input.sessionId)

	// Mirror the autonomous pass's tool calls onto the investigation row. Writes are chained so
	// two heartbeats cannot land out of order, and so `drainProgress` has one promise to await
	// before the runtime is disposed. A failed write is logged and dropped: it is only a feed.
	const progress = makeProgressRecorder()
	let progressWrites: Promise<void> = Promise.resolve()
	const writeProgress = (record: InvestigationProgress | undefined) => {
		if (record === undefined || investigationId === undefined) return
		progressWrites = progressWrites.then(
			(): Promise<void> =>
				runtime
					.runPromise(
						InvestigationService.pipe(
							Effect.flatMap((service) =>
								service.recordProgress(tenant.orgId, investigationId, record),
							),
							Effect.catch((error) =>
								Effect.logWarning("Could not record investigation progress").pipe(
									Effect.annotateLogs({ investigationId, error: error.message }),
								),
							),
						),
					)
					.catch(() => undefined),
		)
	}

	// Flush the steps the heartbeat swallowed and await whatever is in flight. Called before
	// `failInvestigation` so the tail lands while the row is still `investigating`, and again
	// from `ensuring` so an interrupted pass never disposes the runtime mid-write.
	const drainProgress = Effect.suspend(() => {
		writeProgress(progress.pending())
		return Effect.promise(() => progressWrites)
	})

	const program = Effect.gen(function* () {
		const investigations = yield* InvestigationService
		const reviews = yield* PrReviewService
		const conversations = yield* PrReviewConversationService
		const toolExecutor = yield* McpToolExecutor
		const runTenant = yield* withConnectorActor(tenant, origin)
		// Clone the commit while the model reads the diff, rather than when its first source tool
		// asks and waits on it. A child of the turn: a clone still running when the turn ends
		// carries on in the container.
		if (prReviewId !== undefined) {
			yield* reviews.reviewTarget(tenant.orgId, prReviewId).pipe(
				Effect.flatMap(
					Option.match({
						onNone: () => Effect.void,
						onSome: (target) =>
							toolExecutor.prepareRepository(runTenant, {
								repository: target.repository,
								ref: target.headSha,
							}),
					}),
				),
				Effect.catch((error) =>
					Effect.logInfo("Could not prepare the review's checkout").pipe(
						Effect.annotateLogs({ sessionId: input.sessionId, error: error.message }),
					),
				),
				Effect.forkChild,
			)
		}
		// An investigation picks its commit from telemetry mid-pass, so warm the repositories it
		// could read instead: the deployed commit then clones from a filled mirror in seconds.
		if (investigationId !== undefined) {
			yield* toolExecutor.prepareConnectedRepositories(runTenant).pipe(Effect.forkChild)
		}
		const history = input.session.history()
		const model = (
			prReviewId === undefined && prReplyId === undefined ? resolveTriageModel : resolveReviewModel
		)(input.env, { surface, orgId: tenant.orgId, sessionId: input.sessionId, turnId: input.messageId })

		// The session recorded the user's message before the run started, so the transcript's tail is
		// this run's input rather than part of its history.
		// Read once: it is a SQL scan plus a decode, and it is a read-only snapshot.
		const spoken = history.filter((message) => message.text.trim() !== "")
		const latest = spoken.at(-1)
		const text = latest?.role === "user" ? latest.text : ""
		const prior = latest?.role === "user" ? spoken.slice(0, -1) : spoken
		const autonomous = isAutonomousTurn(input.sessionId, origin)
		// One per review turn: the close-out sees what the pass read and keeps what it saved.
		const review =
			prReviewId !== undefined && autonomous
				? { coverage: makeReviewCoverage(text), ledger: makeReviewLedger() }
				: undefined
		// Why the pass, or else its close-out, stopped; the first reason is the one the PR is told.
		let failure: PrReviewFailureReason | undefined
		const holdsTurn = () => input.session.holdsTurn(input.messageId)
		// An autonomous pass ends when the runner says so, not when a run does: a run that stopped
		// in prose or died on a model error gets one close-out turn first, so its terminal is held
		// back until the outcome is known.
		let held: Extract<ChatTurnEvent, { readonly type: "turn-end" }> | undefined
		const run = (turn: {
			readonly text: string
			readonly history: ReadonlyArray<ChatMessage>
			readonly closeOut?: boolean
		}) =>
			runChatTurn({
				sessionId: input.sessionId,
				messageId: input.messageId,
				tenant: runTenant,
				origin,
				toolExecutor,
				model,
				submitDiagnosis: investigations.submitDiagnosis,
				submitReview: reviews.submitReview,
				submitReply: conversations.submitReply,
				stageEdit: conversations.stageEdit,
				...(turn.closeOut === true ? { closeOut: true } : undefined),
				...(review === undefined ? undefined : { review }),
				text: turn.text,
				history: turn.history,
				usage,
				// An abort clears the claim; the run notices at the next event rather than streaming into
				// a conversation that has moved on.
				holdsTurn,
				append: (event) => {
					// The diagnosis call is the run ending, not a step of it; recording it would also
					// race the status flip and land on some rows but not others.
					if (
						autonomous &&
						event.type === "tool-call" &&
						event.proposed !== true &&
						event.name !== SUBMIT_DIAGNOSIS
					) {
						writeProgress(progress.step(event.name, parseToolInput(event.input), Date.now()))
					}
					if (event.type === "turn-end" && event.task === undefined) {
						observability.outcome = event.reason
						if (autonomous && event.reason !== "aborted") {
							held = event
							return
						}
						recordedTerminal = true
					}
					input.session.append(event)
				},
			})

		// A pass that failed is a pass with no diagnosis yet, not a dead turn: the close-out below
		// still gets its say. Interrupts stay interrupts.
		const recoverAutonomousFailure = <R>(effect: Effect.Effect<ChatRunOutcome, unknown, R>) =>
			effect.pipe(
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.failCause(cause)
						: Effect.sync(() => {
								failure ??= reviewFailureReason(cause)
							}).pipe(
								Effect.andThen(Effect.logWarning("Autonomous pass failed; closing it out")),
								Effect.annotateLogs({
									sessionId: input.sessionId,
									messageId: input.messageId,
									cause: summarizeCause(cause),
								}),
								Effect.as<ChatRunOutcome>({
									autonomous: true,
									submitted: false,
									compactions: 0,
								}),
							),
				),
			)

		if (!autonomous) {
			observability.compactions = (yield* run({ text, history: prior })).compactions
			if (!recordedTerminal && !holdsTurn()) observability.outcome = "aborted"
			yield* annotateTurn()
			return
		}

		const first = yield* recoverAutonomousFailure(run({ text, history: prior }))
		observability.compactions = first.compactions
		let submitted = first.submitted
		// Exhausted rather than failed: the engine's final answer ended in prose, not a report.
		if (!submitted && held?.reason === "max-steps") failure ??= "step_limit"
		if (!submitted && holdsTurn()) {
			held = undefined
			const closeOut = yield* recoverAutonomousFailure(
				run({
					text:
						prReplyId !== undefined
							? PR_REPLY_CLOSE_OUT_PROMPT
							: prReviewId === undefined
								? CLOSE_OUT_PROMPT
								: PR_REVIEW_CLOSE_OUT_PROMPT,
					history: withToolTranscript(input.session.history()),
					closeOut: true,
				}),
			)
			observability.compactions = (observability.compactions ?? 0) + closeOut.compactions
			submitted = closeOut.submitted
			yield* Effect.annotateCurrentSpan(
				prReplyId !== undefined
					? "maple.pr_reply.closed_out"
					: prReviewId === undefined
						? "maple.investigation.closed_out"
						: "maple.pr_review.closed_out",
				submitted,
			)
		}

		yield* drainProgress

		if (holdsTurn()) {
			if (!submitted && investigationId !== undefined) {
				observability.failureReason = "NoDiagnosis"
				yield* investigations
					.failInvestigation(tenant.orgId, investigationId, NO_DIAGNOSIS_ERROR)
					.pipe(
						Effect.catchCause((cause) =>
							Effect.logError("Could not record the failed pass", cause),
						),
					)
			}
			if (!submitted && prReplyId !== undefined) {
				observability.failureReason = "NoReply"
				yield* conversations
					.failReply(tenant.orgId, prReplyId, NO_REPLY_ERROR)
					.pipe(
						Effect.catchCause((cause) =>
							Effect.logError("Could not record the failed reply", cause),
						),
					)
			}
			// Findings the pass saved are posted as a partial rather than lost with the report.
			const saved = review?.ledger.findings() ?? []
			if (!submitted && prReviewId !== undefined && review !== undefined && saved.length > 0) {
				submitted = yield* reviews
					.submitReview(
						tenant.orgId,
						prReviewId,
						savedFindingsRequest({
							findings: saved,
							unreviewed: review.coverage.unread(),
							modelName: model.name,
							usage,
						}),
					)
					.pipe(
						Effect.as(true),
						Effect.catchCause((cause) =>
							Effect.logError("Could not file the saved findings", cause).pipe(
								Effect.as(false),
							),
						),
					)
				yield* Effect.annotateCurrentSpan("maple.pr_review.filed_saved_findings", submitted)
			}
			if (!submitted && prReviewId !== undefined) {
				observability.failureReason = "NoReview"
				yield* Effect.annotateCurrentSpan("maple.pr_review.failure_reason", failure ?? "no_report")
				yield* reviews
					.failReview(tenant.orgId, prReviewId, reviewFailureError(failure ?? "no_report"))
					.pipe(
						Effect.catchCause((cause) =>
							Effect.logError("Could not record the failed review", cause),
						),
					)
			}
			input.session.append(
				submitted
					? {
							type: "turn-end",
							messageId: input.messageId,
							reason: held?.reason === "max-steps" ? "max-steps" : "stop",
						}
					: {
							type: "turn-end",
							messageId: input.messageId,
							reason: "error",
							error:
								prReplyId !== undefined
									? NO_REPLY_MESSAGE
									: prReviewId === undefined
										? NO_DIAGNOSIS_MESSAGE
										: NO_REVIEW_MESSAGE,
						},
			)
			recordedTerminal = true
		} else {
			observability.outcome = "aborted"
		}
		yield* annotateTurn()
	}).pipe(
		// `ensuring`, not a trailing statement: a turn that failed, was aborted, or ran out of steps
		// still burned the tokens it burned, and the pre-`ensuring` shape billed none of them.
		Effect.ensuring(Effect.suspend(() => meterTurn(input, tenant, origin, usage))),
		Effect.ensuring(drainProgress),
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
				// Two values, so it groups. Without it "how many bot turns ran, and how many failed"
				// is answerable only by substring-matching the session id.
				"maple.chat.surface": surface,
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
