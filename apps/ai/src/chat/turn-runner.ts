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
import { MCP_ANTICIPATED_ERROR_IDENTIFIERS } from "../mcp/expected-failures"
import { ChatMessage, type ChatTurnOrigin, type ChatTurnTenantEncoded } from "@maple/domain/chat-session"
import { type BillingCustomerId, type PrReviewFailureReason, SubmitPrReviewRequest } from "@maple/domain/http"
import { type ChatSessionNamespace, chatSessionsLayerIfBound } from "@maple/backend/platform/chat-sessions"
import { envPorts } from "@maple/backend/platform/env-ports"
import { CodeLoader } from "@maple/backend/platform/bindings"
import { forkRequestScoped } from "@maple/backend/platform/fork-request-scoped"
import { runtimeTelemetry } from "@maple/infra/worker-telemetry"
import {
	Cause,
	Clock,
	Duration,
	Effect,
	Layer,
	ManagedRuntime,
	Match,
	Option,
	Redacted,
	Schema,
	Array as Arr,
	String as Str,
} from "effect"
import { FetchHttpClient } from "effect/http"
import type { WorkersAiBinding } from "../platform/WorkersAiHttpClient"
import { ReturnedToolFailuresOkLive } from "../platform/genai-spans"
import type { ChatSession } from "./ChatSession"
import { withToolTranscript } from "./close-out"
import {
	CLOSE_OUT_PROMPT,
	PR_REPLY_CLOSE_OUT_PROMPT,
	PR_REVIEW_CLOSE_OUT_PROMPT,
	PR_REVIEW_CONTINUE_PROMPT,
} from "./prompts"
import { INVESTIGATION_PROGRESS_HEARTBEAT, makeProgressFeed, parseToolInput, stepLabel } from "./progress"
import { closeOutFindings, makeChildFindings } from "./review-child-findings"
import { makeReviewCoverage } from "./review-coverage"
import { reviewFailureError, reviewFailureReason } from "./review-failure"
import { makeReviewLedger } from "./review-ledger"
import {
	investigationForSession,
	isAutonomousTurn,
	makeRunUsage,
	prReplyForSession,
	prReviewForSession,
	type RunUsage,
	savedFindingsRequest,
	SUBMIT_DIAGNOSIS,
	SUBMIT_REVIEW,
} from "./tools"

import { abortReason, interruptOnAbort, makeTurnObservability, turnSpanAttributes } from "./turn-outcome"
import { makeAutonomousOutcome, type PhaseKind } from "./autonomous-outcome"
import { type AgentDefinition, agentForSession } from "./agents"
import { profileForTurn } from "./profiles"
import { runChatTurn } from "./run"
import { toTenantContext, turnTenant } from "./turn-actor"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { trackAiCredits, trackTokenUsage } from "@maple/backend/services/billing/autumn-tracker"

/** A best-effort turn step (loading the code executor, disposing the runtime, flushing spans) rejected. */
class TurnRuntimeStepError extends Schema.TaggedError<TurnRuntimeStepError>()(
	"@maple/ai/chat/TurnRuntimeStepError",
	{
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

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
const telemetry = runtimeTelemetry({
	serviceName: "maple-chat",
	anticipatedErrorIdentifiers: MCP_ANTICIPATED_ERROR_IDENTIFIERS,
	dropSpanNames: ENGINE_BOOKKEEPING_SPANS,
})

export interface RunChatSessionTurnInput {
	/** The Durable Object itself. Appends are direct calls, not stub RPC. */
	readonly session: ChatSession
	readonly sessionId: string
	readonly env: Record<string, unknown>
	/** The Workers AI gateway binding, from the activation; none sends Workers AI calls over REST. */
	readonly workersAi?: Option.Option<WorkersAiBinding>
	/** This Worker's `ChatSession` namespace, from the activation; the graph's `ChatSessions` port. */
	readonly chatSessions?: ChatSessionNamespace
	readonly messageId: string
	readonly tenant: ChatTurnTenantEncoded
	/** Who is driving the turn, stated by whoever raised it. */
	readonly origin: ChatTurnOrigin
	/**
	 * Set when the session starts an evicted turn again. The kickoff is already in the log, under
	 * `userMessageId`, followed by the dead attempt; the run reads from the kickoff, not the tail.
	 */
	readonly resume?: { readonly userMessageId: string; readonly text: string; readonly attempt: number }
	/** The turn was evicted too often to start again: record that it failed, and run nothing. */
	readonly abandoned?: true
	/** Aborted, with a `ChatAbortReason`, when the session aborts this turn: the run is interrupted. */
	readonly signal?: AbortSignal
}

/**
 * Metering is housekeeping, and it runs after the answer, on the way out of the turn.
 *
 * A turn that did not end itself is ended in the `finally` of `ChatSession.runTurn`, so whatever
 * the metering finalizer waits on can hold the session's turn slot, and the stale-claim reclaim is tens of minutes out
 * (`TURN_STALE_MS` in `ChatSession.ts`). Unbounded, a POST to Autumn that never answers is a way
 * for a third party's outage to wedge a conversation.
 *
 * On timeout the request is abandoned rather than aborted: it may still land, and if it does not,
 * one turn goes unbilled. That is the trade the tracker already makes for a failed request.
 */
const METERING_TIMEOUT = "5 seconds"

const NO_DIAGNOSIS_MESSAGE = "Maple ended this investigation without a diagnosis."
/** What the row records when the pass and its close-out both ended in prose or on an error. */
const NO_DIAGNOSIS_ERROR = "no_diagnosis: the agent ended its pass without submitting a diagnosis; retry"
/** What the row records when the turn was stopped before its report. */
const NO_DIAGNOSIS_INTERRUPTED = "interrupted: the run was stopped before it submitted a diagnosis; retry"
const NO_REVIEW_MESSAGE = "Maple ended this review without a report."
const NO_REPLY_MESSAGE = "Maple ended this answer without posting it."
const NO_REPLY_ERROR = "no_reply: the agent ended its pass without submitting an answer"
/** How long a row write that settles an unfinished turn may take; it can run in a finalizer. */
const ROW_WRITE_TIMEOUT = "10 seconds"
/** How long filing a review's saved findings may take once the turn has started settling. */
const SUBMIT_SAVED_TIMEOUT = "60 seconds"
/** A review pass that answered in prose gets another pass only with at least this much of its clock left. */
const MIN_CONTINUE_MS = 2 * 60 * 1000

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
 * **Two meters while AI credits roll out.** `ai_credits` charges each model call in dollars,
 * priced by Autumn from the model's rates, so a cache read or a cheap model costs what it costs.
 * The raw `ai_input_tokens` / `ai_output_tokens` counts keep running beside it for comparison.
 *
 * **In a finalizer, not on the happy path.** A turn that failed, was stopped, or ran out of steps
 * is still billed for every step the provider actually served — the loop accounts a step's usage
 * before it checks whether the turn survived. Metering follows the spend, not the outcome. (A step
 * interrupted before the provider's terminal event reports no usage at all, so that much is
 * unbillable rather than unbilled.)
 *
 * **Nothing for a turn on the org's own key.** OpenRouter bills the org for those tokens directly,
 * so charging them here as well would bill the same spend twice.
 */
export const meterTurn = (
	input: Pick<RunChatSessionTurnInput, "sessionId" | "messageId">,
	/** The org that pays for the turn: `BillingCustomerResolver.customerFor` of the turn's org. */
	customerId: BillingCustomerId,
	origin: ChatTurnOrigin,
	usage: Pick<RunUsage, "input" | "output" | "charges">,
	options: { readonly ownKey?: boolean } = {},
): Effect.Effect<void> => {
	if (options.ownKey === true) return Effect.void
	if (usage.input <= 0 && usage.output <= 0) return Effect.void
	const billing = investigationBilling(input.sessionId, input.messageId) ??
		reviewBilling(input.sessionId, input.messageId) ?? {
			source: profileForTurn(agentForSession(input.sessionId), origin).surface,
			idempotencyKey: `${input.sessionId}:${input.messageId}`,
		}
	// Bookkeeping must never fail a delivered answer: the tracker is infallible and bounded here too.
	// It runs as a finalizer, outside any graph that is sure to carry an HttpClient, so it brings its own.
	return Effect.all(
		[
			trackAiCredits({
				customerId,
				spends: usage.charges,
				idempotencyKey: billing.idempotencyKey,
				source: billing.source,
			}),
			trackTokenUsage({
				customerId,
				inputTokens: usage.input,
				outputTokens: usage.output,
				idempotencyKey: billing.idempotencyKey,
				source: billing.source,
			}),
		],
		{ concurrency: "unbounded", discard: true },
	).pipe(
		Effect.timeout(METERING_TIMEOUT),
		Effect.ignore,
		// oxlint-disable-next-line effecttsgo/strict-effect-provide -- metering is forked off the turn and runs on its own HTTP client
		Effect.provide(FetchHttpClient.layer),
	)
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
		{ DatabasePgLive },
		{ layerMapleDbConnection },
		{
			layerDecisionModelFromConfig,
			FindingEmbedderFromConfigLive,
			layerLlmFromConfig,
			layerOpenRouterClient,
			loadLlmSettings,
			resolveReviewModel,
			resolveTriageModel,
			withOrgOpenRouterKey,
		},
		{ McpToolExecutor },
		{ withSandboxBreaker },
	] = await Promise.all([
		import("../runtime/mcp-service-graph"),
		import("@maple/backend/platform/DatabasePgLive"),
		import("@maple/backend/platform/pg-connection-source"),
		import("../platform/Llm"),
		import("../mcp/dispatcher"),
		import("./sandbox-breaker"),
	])
	const { InvestigationService } = await import("@maple/backend/services/errors/InvestigationService")
	const { PrReviewService } = await import("@maple/backend/services/pr-review/PrReviewService")
	const { PrReviewConversationService } =
		await import("@maple/backend/services/pr-review/PrReviewConversationService")
	const { OrgOpenRouterKeyService } = await import("@maple/backend/services/org/OrgOpenRouterKeyService")
	const { BillingCustomerResolver } =
		await import("@maple/backend/services/billing/BillingCustomerResolver")

	const runtime = ManagedRuntime.make(
		InvestigationServicesLive.pipe(
			Layer.provideMerge(layerDecisionModelFromConfig(input.workersAi)),
			// Read by `PrReviewService` as it is built: the review's feedback filter.
			Layer.provideMerge(FindingEmbedderFromConfigLive),
			Layer.provideMerge(layerLlmFromConfig(input.workersAi)),
			Layer.provideMerge(DatabasePgLive),
			Layer.provideMerge(layerMapleDbConnection(input.env)),
			Layer.provideMerge(envPorts(input.env)),
			Layer.provideMerge(chatSessionsLayerIfBound(input.chatSessions, input.env)),
			Layer.provideMerge(ReturnedToolFailuresOkLive.pipe(Layer.provideMerge(telemetry.layer))),
		),
	)

	const tenant = toTenantContext(input.tenant, origin)
	// One answer for the model's tags and the turn span, the same one the toolkit is built from.
	// `meterTurn` resolves its own because it runs as a finalizer and is separately exported.
	const agent = agentForSession(input.sessionId)
	const surface = profileForTurn(agent, origin).surface
	const observability = makeTurnObservability()
	// Hoisted out of the program: `submit_diagnosis` reads it mid-run — the tool is invoked mid-run
	// so there is no later moment to hand it a total — and the metering finalizer reads it after the
	// turn has ended, including when it ended by failing.
	const usage = makeRunUsage()
	// `empty_output` and `recovery_count` are gone with the machinery that produced them: they
	// counted the old loop's own repair attempts, and the engine has no equivalent to report.
	const annotateTurn = () => Effect.annotateCurrentSpan(turnSpanAttributes(observability, input.signal))

	const investigationId = investigationForSession(input.sessionId)
	const prReviewId = prReviewForSession(input.sessionId)
	const prReplyId = prReplyForSession(input.sessionId)

	const turnBody = (orgKey: Option.Option<Redacted.Redacted>) =>
		Effect.gen(function* () {
			const investigations = yield* InvestigationService
			const reviews = yield* PrReviewService
			const conversations = yield* PrReviewConversationService
			// Shared by the kickoff's clone, every pass of the turn and its review_files children.
			const mcpToolExecutor = yield* McpToolExecutor
			const toolExecutor = yield* withSandboxBreaker(mcpToolExecutor)
			const runTenant = yield* turnTenant(tenant, origin).pipe(
				// The asker's linked Maple user may not read this org: nothing runs, and the message
				// is the only thing that tells them why.
				Effect.catchTag("@maple/ai/LinkedUserNotPermitted", (refusal) =>
					Effect.sync(() => {
						observability.outcome = "error"
						observability.failureReason = `LinkedUserNotPermitted:${refusal.reason}`
						input.session.endTurn(input.messageId, { reason: "error", error: refusal.message })
						return undefined
					}),
				),
			)
			if (runTenant === undefined) return yield* annotateTurn()
			if (prReviewId !== undefined && input.abandoned === true) {
				observability.outcome = "abandoned"
				yield* reviews
					.failReview(tenant.orgId, prReviewId, reviewFailureError("interrupted"))
					.pipe(
						Effect.catchCause((cause) =>
							Effect.logError("Could not record the abandoned review", cause),
						),
					)
				yield* annotateTurn()
				return
			}
			// The dead attempt may have filed its report, or a newer head superseded it, before the
			// object went down: then there is nothing left to run.
			if (prReviewId !== undefined && input.resume !== undefined) {
				yield* Effect.annotateCurrentSpan("maple.pr_review.resume_attempt", input.resume.attempt)
				// An unreadable row reviews anyway: the row's own guards still refuse a second report.
				const current = yield* reviews
					.getReview(tenant.orgId, prReviewId)
					.pipe(
						Effect.catchCause((cause) =>
							Effect.logWarning(
								"Could not read the review being resumed; reviewing anyway",
								cause,
							).pipe(Effect.as(Option.none())),
						),
					)
				const settled = Option.match(current, {
					onNone: () => false,
					onSome: (review) => review.status !== "queued" && review.status !== "running",
				})
				if (settled) {
					observability.outcome = "resume_skipped"
					input.session.endTurn(input.messageId, { reason: "stop" })
					yield* annotateTurn()
					return
				}
			}
			// Read before the run: the diff tools are pinned to it. An unreadable target reviews unpinned.
			const target =
				prReviewId === undefined
					? Option.none()
					: yield* reviews.reviewTarget(tenant.orgId, prReviewId).pipe(
							Effect.catch((error) =>
								Effect.logInfo("Could not read the review's target").pipe(
									Effect.annotateLogs({
										sessionId: input.sessionId,
										error: error.message,
									}),
									Effect.as(Option.none()),
								),
							),
						)
			// Clone the commit while the model reads the diff, rather than when its first source tool
			// asks and waits on it. A child of the turn (no request Scope here, so `forkRequestScoped`
			// parents it on this fiber): a clone still running when the turn ends carries on in the container.
			if (Option.isSome(target)) {
				yield* toolExecutor
					.prepareRepository(runTenant, {
						repository: target.value.repository,
						ref: target.value.headSha,
					})
					.pipe(
						Effect.catch((error) =>
							Effect.logInfo("Could not prepare the review's checkout").pipe(
								Effect.annotateLogs({ sessionId: input.sessionId, error: error.message }),
							),
						),
						forkRequestScoped,
					)
			}
			// An investigation picks its commit from telemetry mid-pass, so warm the repositories it
			// could read instead: the deployed commit then clones from a filled mirror in seconds.
			if (investigationId !== undefined) {
				yield* forkRequestScoped(toolExecutor.prepareConnectedRepositories(runTenant))
			}
			const history = input.session.history()
			const tags = { surface, orgId: tenant.orgId, sessionId: input.sessionId, turnId: input.messageId }
			const deploySettings = yield* loadLlmSettings
			// An org on its own OpenRouter key runs every model call of the turn on it.
			const settings = Option.match(orgKey, {
				onNone: () => deploySettings,
				onSome: (apiKey) => withOrgOpenRouterKey(deploySettings, apiKey),
			})
			// Rebuilt from the turn's settings so the org's key, when there is one, replaces the runtime's.
			const openRouterClient = layerOpenRouterClient(settings)
			const model = yield* Match.value(agent.model).pipe(
				Match.when("triage", () =>
					Effect.succeed(
						resolveTriageModel(settings, tags, isAutonomousTurn(input.sessionId, origin)),
					),
				),
				Match.when("review", () =>
					reviews
						.reviewModel(tenant.orgId)
						.pipe(Effect.map((chosen) => resolveReviewModel(settings, tags, chosen))),
				),
				Match.exhaustive,
			)

			// The session recorded the user's message before the run started, so the transcript's tail is
			// this run's input rather than part of its history.
			// Read once: it is a SQL scan plus a decode, and it is a read-only snapshot.
			const spoken = Arr.filter(history, (message) => Str.trim(message.text) !== "")
			const latest = spoken.at(-1)
			// Unbound (a stage without Dynamic Workers), the agents run without `run_code`. Imported only
			// when bound: the adapter needs `cloudflare:workers`, which nothing outside workerd resolves.
			// A failed import is logged and the turn runs without the tool, never fails over it.
			const codeLoader = yield* CodeLoader
			const codeExecutor =
				agent.codeMode !== true || Option.isNone(codeLoader)
					? undefined
					: yield* Effect.tryPromise({
							try: () => import("@yielded/agent-platform-cloudflare/cloudflare-code-mode"),
							catch: (cause) =>
								new TurnRuntimeStepError({
									message: "Failed to load the code executor",
									cause,
								}),
						}).pipe(
							Effect.map(({ dynamicWorkerCodeExecutorLayer }) =>
								dynamicWorkerCodeExecutorLayer({ loader: codeLoader.value }),
							),
							Effect.catch((error) =>
								Effect.logWarning(
									"run_code unavailable: the code executor failed to load",
								).pipe(
									Effect.annotateLogs({ cause: String(error.cause) }),
									Effect.as(undefined),
								),
							),
						)
			// A restarted turn reads from its kickoff: what came after it is the attempt that died.
			const resume = input.resume
			const text = resume?.text ?? (latest?.role === "user" ? latest.text : "")
			const prior =
				resume !== undefined
					? Option.match(
							Arr.findFirstIndex(
								spoken,
								(message) => message.role === "user" && message.id === resume.userMessageId,
							),
							{ onNone: () => spoken, onSome: (kickoff) => spoken.slice(0, kickoff) },
						)
					: latest?.role === "user"
						? spoken.slice(0, -1)
						: spoken
			const autonomous = isAutonomousTurn(input.sessionId, origin)
			// One per review turn: the close-out sees what the pass read and keeps what it saved.
			const review =
				prReviewId !== undefined && autonomous
					? {
							coverage: makeReviewCoverage(text),
							ledger: makeReviewLedger(),
							childFindings: makeChildFindings(),
						}
					: undefined
			// The autonomous pass's tool calls show on the investigation row until its report is on its way. A failed write is logged and dropped: it is only a feed.
			const investigationFeed =
				investigationId !== undefined && autonomous
					? yield* makeProgressFeed({
							label: stepLabel,
							heartbeat: INVESTIGATION_PROGRESS_HEARTBEAT,
							write: (record) =>
								investigations.recordProgress(tenant.orgId, investigationId, record).pipe(
									Effect.catch((error) =>
										Effect.logWarning("Could not record investigation progress").pipe(
											Effect.annotateLogs({
												investigationId,
												error: error.message,
											}),
										),
									),
								),
						})
					: undefined
			// The tail lands while the row is still active, and the report's own write lands last. A
			// report that does not land hands the row back to the feed, since the pass goes on.
			const beforeReport = <A, E>(submit: Effect.Effect<A, E>) =>
				investigationFeed === undefined
					? submit
					: investigationFeed.flush.pipe(
							Effect.andThen(investigationFeed.pause),
							Effect.andThen(submit),
							Effect.onError(() => investigationFeed.resume),
						)
			const closeFeeds =
				investigationFeed === undefined
					? Effect.void
					: investigationFeed.flush.pipe(Effect.andThen(investigationFeed.close))
			// Every phase's ending, recorded as it settles: the PR's reason and the final turn-end
			// are read from all of them.
			const outcome = makeAutonomousOutcome()
			const holdsTurn = () => input.session.holdsTurn(input.messageId)
			// Whether a conversation turn's run wrote its own ending (non-autonomous only).
			let recordedTerminal = false
			const run = (turn: {
				readonly text: string
				readonly history: ReadonlyArray<ChatMessage>
				readonly closeOut?: boolean
				/** A continuation's agent: the session's, with only what is left of the pass's clock. */
				readonly agent?: AgentDefinition
			}) =>
				runChatTurn({
					sessionId: input.sessionId,
					messageId: input.messageId,
					tenant: runTenant,
					origin,
					toolExecutor,
					model,
					submitDiagnosis: (orgId, id, request) =>
						beforeReport(investigations.submitDiagnosis(orgId, id, request)),
					// A partial carries why the pass before it stopped, so the pull request is told that.
					submitReview: (orgId, reviewId, request) =>
						beforeReport(
							reviews.submitReview(
								orgId,
								reviewId,
								Option.match(Option.fromUndefinedOr(outcome.failure()), {
									onNone: () => request,
									onSome: (partialReason) =>
										request.partial === true
											? new SubmitPrReviewRequest({ ...request, partialReason })
											: request,
								}),
							),
						),
					submitReply: conversations.submitReply,
					stageEdit: conversations.stageEdit,
					...(turn.closeOut === true ? { closeOut: true } : undefined),
					...(turn.agent === undefined ? undefined : { agent: turn.agent }),
					...(review === undefined ? undefined : { review }),
					...(codeExecutor === undefined ? undefined : { codeExecutor }),
					...Option.match(target, {
						onNone: () => undefined,
						onSome: ({ repository, number }) => ({ pullRequest: { repository, number } }),
					}),
					text: turn.text,
					history: turn.history,
					usage,
					// An abort clears the claim; the run notices at the next event rather than streaming into
					// a conversation that has moved on.
					holdsTurn,
					append: (event) => {
						// The report call is the run ending, not a step of it.
						if (
							event.type === "tool-call" &&
							event.proposed !== true &&
							event.name !== SUBMIT_DIAGNOSIS &&
							event.name !== SUBMIT_REVIEW
						) {
							investigationFeed?.step(event.name, parseToolInput(event.input))
						}
						if (event.type === "turn-end" && event.task === undefined) {
							observability.outcome = event.reason
							// An autonomous pass ends when the runner says so, not when a run does.
							if (autonomous && event.reason !== "aborted") return outcome.hold(event.reason)
							const { reason, error } = event
							recordedTerminal = input.session.endTurn(
								input.messageId,
								error === undefined ? { reason } : { reason, error },
							)
							return
						}
						input.session.append(event)
					},
					// oxlint-disable-next-line effecttsgo/strict-effect-provide -- the turn's OpenRouter client is built per turn from its settings
				}).pipe(Effect.provide(openRouterClient))

			/**
			 * One phase, settled into `outcome`. A pass that failed is a pass with no report yet, not a
			 * dead turn: the close-out still gets its say. Interrupts stay interrupts.
			 */
			const phase = (kind: PhaseKind, turn: Parameters<typeof run>[0]) =>
				run(turn).pipe(
					Effect.map((result) => ({ result, raised: undefined })),
					Effect.catchCauseIf(
						(cause) => !Cause.hasInterruptsOnly(cause),
						(cause) =>
							Effect.logWarning("Autonomous pass failed; closing it out").pipe(
								Effect.annotateLogs({
									sessionId: input.sessionId,
									messageId: input.messageId,
									cause: summarizeCause(cause),
								}),
								Effect.as({
									result: { autonomous: true, submitted: false, compactions: 0 },
									raised: reviewFailureReason(cause, { ownKey: Option.isSome(orgKey) }),
								}),
							),
					),
					Effect.map(({ result, raised }) => {
						observability.compactions = (observability.compactions ?? 0) + result.compactions
						return outcome.record(kind, result.submitted, raised)
					}),
				)

			if (!autonomous) {
				observability.compactions = (yield* run({ text, history: prior })).compactions
				if (!recordedTerminal && !holdsTurn()) observability.outcome = "aborted"
				yield* annotateTurn()
				return
			}

			// Record a turn that stopped without a report on its rows. Not on a supersede: the newer
			// head's review owns the row and marks it skipped itself. Bounded, since it can run in a finalizer.
			const settleRow = <E>(write: Effect.Effect<void, E>, failed: string) =>
				write.pipe(
					Effect.timeout(ROW_WRITE_TIMEOUT),
					Effect.catchCause((cause) => Effect.logError(failed, cause)),
				)
			const failUnfinished = (reason: PrReviewFailureReason, investigationError: string) =>
				Effect.gen(function* () {
					if (outcome.submitted()) return
					if (Option.contains(abortReason(input.signal), "superseded")) return
					if (investigationId !== undefined) {
						observability.failureReason = "NoDiagnosis"
						yield* settleRow(
							investigations.failInvestigation(
								tenant.orgId,
								investigationId,
								investigationError,
							),
							"Could not record the failed pass",
						)
					}
					if (prReplyId !== undefined) {
						observability.failureReason = "NoReply"
						yield* settleRow(
							conversations.failReply(tenant.orgId, prReplyId, NO_REPLY_ERROR),
							"Could not record the failed reply",
						)
					}
					if (prReviewId !== undefined) {
						observability.failureReason = "NoReview"
						yield* Effect.annotateCurrentSpan("maple.pr_review.failure_reason", reason)
						yield* settleRow(
							reviews.failReview(tenant.orgId, prReviewId, reviewFailureError(reason)),
							"Could not record the failed review",
						)
					}
				})

			// An abort between or during phases still settles the rows: nothing else would move a
			// review off `running` before the stale sweeps.
			const aborted = Effect.suspend(() => {
				observability.outcome = "aborted"
				return failUnfinished("interrupted", NO_DIAGNOSIS_INTERRUPTED)
			})

			const autonomousTurn = Effect.gen(function* () {
				const passDeadline =
					(yield* Clock.currentTimeMillis) +
					Duration.toMillis(Duration.fromInputUnsafe(agent.budget.maxDuration))
				const remainingAgent = (remaining: number): AgentDefinition => ({
					...agent,
					budget: { ...agent.budget, maxDuration: Duration.millis(remaining) },
				})
				yield* phase("pass", { text, history: prior })
				// A review stopped for failing tool calls is usually a bad start, not an impossible review:
				// it starts over once from the kickoff, inside the same wall clock, without the failed calls.
				if (
					!outcome.submitted() &&
					outcome.failure() === "stuck" &&
					prReviewId !== undefined &&
					holdsTurn()
				) {
					const remaining = passDeadline - (yield* Clock.currentTimeMillis)
					if (remaining >= MIN_CONTINUE_MS) {
						const restarted = yield* phase("restart", {
							text,
							history: prior,
							agent: remainingAgent(remaining),
						})
						yield* Effect.annotateCurrentSpan("maple.pr_review.restarted", restarted.submitted)
					}
				}
				// A review that answered in prose with no limit hit was not stopped, it stopped itself. With
				// time left it gets one more pass that may still read, inside the same wall clock.
				if (
					!outcome.submitted() &&
					outcome.failure() === undefined &&
					prReviewId !== undefined &&
					holdsTurn()
				) {
					const remaining = passDeadline - (yield* Clock.currentTimeMillis)
					if (remaining >= MIN_CONTINUE_MS) {
						const continued = yield* phase("continue", {
							// The replayed history keeps only its newest part, which can drop the kickoff.
							text: `${PR_REVIEW_CONTINUE_PROMPT}\n\n${text}`,
							history: withToolTranscript(input.session.history()),
							agent: remainingAgent(remaining),
						})
						yield* Effect.annotateCurrentSpan("maple.pr_review.continued", continued.submitted)
					}
					if (!outcome.submitted() && outcome.failure() === undefined)
						outcome.fail("answered_in_prose")
				}
				if (!outcome.submitted() && holdsTurn()) {
					const closeOut = yield* phase("close-out", {
						text:
							prReplyId !== undefined
								? PR_REPLY_CLOSE_OUT_PROMPT
								: prReviewId === undefined
									? CLOSE_OUT_PROMPT
									: PR_REVIEW_CLOSE_OUT_PROMPT,
						history: withToolTranscript(input.session.history()),
						closeOut: true,
					})
					yield* Effect.annotateCurrentSpan(
						prReplyId !== undefined
							? "maple.pr_reply.closed_out"
							: prReviewId === undefined
								? "maple.investigation.closed_out"
								: "maple.pr_review.closed_out",
						closeOut.submitted,
					)
				}

				yield* closeFeeds
			})

			// Once the phases are over the rows are settled exactly once: uninterruptible, so an abort
			// arriving now cannot cut a write short and settle them a second time as interrupted.
			const settleTurn = Effect.gen(function* () {
				if (!holdsTurn()) return yield* aborted
				// Findings the pass saved, and its children's warnings, are posted as a partial rather
				// than lost with the report.
				const saved = closeOutFindings(
					review?.ledger.findings() ?? [],
					review?.childFindings?.all() ?? [],
				)
				if (
					!outcome.submitted() &&
					prReviewId !== undefined &&
					review !== undefined &&
					saved.length > 0
				) {
					const failure = outcome.failure()
					const filed = yield* reviews
						.submitReview(
							tenant.orgId,
							prReviewId,
							savedFindingsRequest({
								findings: saved,
								unreviewed: review.coverage.unread(),
								modelName: model.name,
								usage,
								...(failure === undefined ? undefined : { reason: failure }),
							}),
						)
						.pipe(
							Effect.as(true),
							// Settling is uninterruptible, so a hung submit is bounded; `failReview` skips a filed review.
							Effect.timeout(SUBMIT_SAVED_TIMEOUT),
							Effect.catchCause((cause) =>
								Effect.logError("Could not file the saved findings", cause).pipe(
									Effect.as(false),
								),
							),
						)
					outcome.record("verdict", filed)
					yield* Effect.annotateCurrentSpan("maple.pr_review.filed_saved_findings", filed)
				}
				yield* failUnfinished(outcome.failure() ?? "no_report", NO_DIAGNOSIS_ERROR)
				input.session.endTurn(
					input.messageId,
					outcome.ending(
						prReplyId !== undefined
							? NO_REPLY_MESSAGE
							: prReviewId === undefined
								? NO_DIAGNOSIS_MESSAGE
								: NO_REVIEW_MESSAGE,
					),
				)
			})

			yield* Effect.uninterruptibleMask((restore) =>
				restore(autonomousTurn).pipe(
					Effect.onInterrupt(() => aborted),
					Effect.andThen(settleTurn),
				),
			)
			yield* annotateTurn()
		})

	const program = Effect.gen(function* () {
		const orgKey = yield* (yield* OrgOpenRouterKeyService).resolveForRun(tenant.orgId)
		yield* Effect.annotateCurrentSpan("maple.llm.byok", Option.isSome(orgKey))
		// Resolved before the turn so the finalizer has nothing left to look up. A failed lookup
		// meters nothing rather than a guess: the org's own customer may be the wrong card.
		const customerId = yield* (yield* BillingCustomerResolver).customerFor(tenant.orgId).pipe(
			Effect.asSome,
			Effect.catchTag("@maple/http/errors/BillingAccountPersistenceError", (error) =>
				Effect.logError("Billing org lookup failed; this turn's AI usage is not metered").pipe(
					Effect.annotateLogs({
						orgId: tenant.orgId,
						sessionId: input.sessionId,
						messageId: input.messageId,
						error: error.message,
					}),
					Effect.as(Option.none<BillingCustomerId>()),
				),
			),
		)
		return yield* turnBody(orgKey).pipe(
			interruptOnAbort(input.signal, observability),
			// `ensuring`, not a trailing statement: a turn that failed, was aborted, or ran out of steps
			// still burned the tokens it burned, and the pre-`ensuring` shape billed none of them.
			Effect.ensuring(
				Effect.suspend(() =>
					Option.match(customerId, {
						onNone: () => Effect.void,
						onSome: (payer) =>
							meterTurn(input, payer, origin, usage, { ownKey: Option.isSome(orgKey) }),
					}),
				),
			),
		)
	}).pipe(
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

	// A turn that failed is ended by the session once this returns (`ChatSession.runTurn`), with
	// stable copy: the detailed cause stays in server logs and the failed span.
	await runtime.runPromiseExit(program)
	await Effect.runPromise(releaseQuietly(runtime, () => telemetry.flush(input.env)))
}

/**
 * Dispose the turn's runtime, then flush its spans. Best effort: the turn's outcome is already in
 * the log, so a failed dispose or export is dropped rather than failing the caller.
 */
const releaseQuietly = (
	runtime: { readonly dispose: () => Promise<void> },
	flush: () => Promise<void>,
): Effect.Effect<void> =>
	Effect.tryPromise({
		try: () => runtime.dispose(),
		catch: (cause) => new TurnRuntimeStepError({ message: "Failed to dispose the turn runtime", cause }),
	}).pipe(
		Effect.ignore,
		Effect.andThen(
			Effect.tryPromise({
				try: flush,
				catch: (cause) =>
					new TurnRuntimeStepError({ message: "Failed to flush the turn spans", cause }),
			}).pipe(Effect.ignore),
		),
	)
