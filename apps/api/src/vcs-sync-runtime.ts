import { EdgeCacheServiceLive } from "@maple/backend/platform/CacheBackendLive"
import { Cause, Effect, Layer, Option } from "effect"
import { EventBaseLive } from "@maple/backend/platform/DatabasePgLive"

import { VcsScheduledSyncService } from "@maple/backend/services/integrations/vcs/VcsScheduledSyncService"
import {
	clampQueueDelaySeconds,
	MESSAGING_DESTINATION,
	MESSAGING_SYSTEM,
	VcsSyncQueue,
} from "@maple/backend/services/integrations/vcs/VcsSyncQueue"
import { VcsSyncService } from "@maple/backend/services/integrations/vcs/VcsSyncService"

import { IssueFixVerificationService } from "@maple/backend/services/errors/IssueFixVerificationService"
import { PullRequestLookup } from "@maple/backend/services/errors/PullRequestLookup"
import { fixVerificationPullRequestHandler } from "@maple/backend/services/errors/pull-request-sink-live"
import { pullRequestEventSinkFanout } from "@maple/backend/services/integrations/vcs/PullRequestEventSink"
import { PrReviewService } from "@maple/backend/services/pr-review/PrReviewService"
import { prReviewPullRequestHandler } from "@maple/backend/services/pr-review/pull-request-review-handler"
import {
	PullRequestChecklistSinkLive,
	PullRequestCiApprovalSinkLive,
	PullRequestCommentSinkLive,
} from "@maple/backend/services/pr-review/pull-request-comment-handler"
import { CiTraceSinkLive } from "@maple/backend/services/integrations/ci-traces/CiTraceService"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import type { QueueBatch } from "@maple/backend/platform/queue-batch"
import type { Message } from "@cloudflare/workers-types"
import {
	applyOutcome,
	type MessageOutcome,
	type PlacedMessage,
	toPlacedMessage,
	VCS_SYNC_MAX_RETRIES,
	vcsSyncTelemetry,
} from "./worker/vcs-sync-dispatch"

// Per-invocation runtime for the VCS sync queue, independent of the HTTP graph.
// No tracer or logger of its own: the Worker provides `vcsSyncTelemetry` around
// the event, and a layer here that carried one would shadow it. The Worker env,
// its `ConfigProvider` and the binding ports come from the Worker too
// (`apiPorts`), provided around the event.

// Defined beside the dispatch, which the Worker imports eagerly; one SDK instance per isolate.
export { vcsSyncTelemetry }

// One delivery, two readers: the issue link / verification window, and the
// review trigger. Each is isolated in the fan-out so a defect in
// one never costs the other the event.
// The review trigger re-enqueues a push to debounce it, so it gets the queue here. One value, so
// the event fan-out and the checklist sink share the instance.
const PrReviewLive = PrReviewService.layer.pipe(Layer.provide(VcsSyncQueue.layer))

const PullRequestEventSinkLive = pullRequestEventSinkFanout<IssueFixVerificationService | PrReviewService>([
	{ name: "fix-verification", handler: fixVerificationPullRequestHandler },
	{ name: "pr-review", handler: prReviewPullRequestHandler },
]).pipe(
	Layer.provide(IssueFixVerificationService.layer),
	Layer.provide(PrReviewLive),
	Layer.provide(PullRequestLookup.none),
)

export const VcsSyncLive = VcsSyncService.layer.pipe(
	Layer.provide(PullRequestEventSinkLive),
	// `@maple` mentions on pull requests; the review debounce's queue is not needed to answer.
	Layer.provide(PullRequestCommentSinkLive),
	// A maintainer approving an outside contributor's CI runs that pull request's review.
	Layer.provide(PullRequestCiApprovalSinkLive),
	// Ticked "Before merge" boxes on review comments.
	Layer.provide(PullRequestChecklistSinkLive.pipe(Layer.provide(PrReviewLive))),
	// Finished CI runs and jobs, written as spans into the org's traces.
	Layer.provide(CiTraceSinkLive),
	Layer.provide(Layer.mergeAll(EventBaseLive, EdgeCacheServiceLive)),
)

export const VcsScheduledLive = VcsScheduledSyncService.layer.pipe(Layer.provide(EventBaseLive))

// The cron program: enqueue a periodic refresh per processable installation.
export const runScheduledSync = Effect.gen(function* () {
	const scheduler = yield* VcsScheduledSyncService
	const result = yield* scheduler.runScheduledSync()
	// Duplicate counts onto the tick span so cron-level traces are filterable without drilling into child spans.
	yield* Effect.annotateCurrentSpan({
		"vcs.scheduled.installations_total": result.installationsTotal,
		"vcs.scheduled.enqueued": result.enqueued,
		"vcs.scheduled.skipped": result.skipped,
	})
	yield* Effect.annotateCurrentSpan({ "vcs.scheduled.outcome": "completed" })
	yield* Effect.logInfo("[VCS] scheduled sync tick complete").pipe(
		Effect.annotateLogs({
			installationsTotal: result.installationsTotal,
			enqueued: result.enqueued,
			skipped: result.skipped,
		}),
	)
}).pipe(
	// tapCause lets the cause propagate so `withSpan` marks `VcsScheduledSync.tick` as Error.
	Effect.tapCause((cause) =>
		Effect.annotateCurrentSpan({ "vcs.scheduled.outcome": "failed" }).pipe(
			Effect.flatMap(() =>
				Effect.logError("[VCS] scheduled sync tick failed").pipe(
					Effect.annotateLogs({ error: summarizeCause(cause) }),
				),
			),
		),
	),
	Effect.withSpan("VcsScheduledSync.tick"),
)

// No DLQ exists, so on the final delivery (attempt > max_retries) we persist a terminal status
// instead of silently dropping.

const settleMessage = (service: VcsSyncService["Service"], message: PlacedMessage) =>
	service.processMessage(message.body).pipe(
		Effect.matchCauseEffect({
			onFailure: (cause): Effect.Effect<MessageOutcome> => {
				// Rate-limited: delay redelivery until the VCS budget resets instead of retrying immediately.
				const failure = Option.getOrUndefined(Cause.findErrorOption(cause))
				const isRateLimited = failure?._tag === "@maple/http/errors/VcsRateLimitedError"

				const delaySeconds = isRateLimited
					? clampQueueDelaySeconds(failure.retryAfterSeconds)
					: undefined
				const isDelaySecondsSet = delaySeconds !== undefined
				// Last retry exhausted: persist terminal status so repos don't get stuck backfilling, then ack.
				const isFinalAttempt = message.attempts > VCS_SYNC_MAX_RETRIES

				// Low-cardinality outcome label; the full Cause stays in the log, not the span.
				const outcome = isFinalAttempt ? "exhausted" : isDelaySecondsSet ? "retry_delayed" : "retry"

				return Effect.annotateCurrentSpan({
					"vcs.queue.message.outcome": outcome,
					// Tag rate-limit errors so `retry_delayed`/`exhausted` spans are filterable without parsing logs.
					...(isRateLimited
						? { "vcs.queue.failure.tag": "@maple/http/errors/VcsRateLimitedError" }
						: undefined),
					...(isDelaySecondsSet ? { "vcs.queue.retry.delay_seconds": delaySeconds } : undefined),
				}).pipe(
					Effect.flatMap(() =>
						Effect.logError("[VCS] sync message failed").pipe(
							Effect.annotateLogs({
								error: summarizeCause(cause),
								attempt: message.attempts,
								outcome,
								...(isFinalAttempt ? { exhausted: true } : undefined),
								...(isDelaySecondsSet ? { retryDelaySeconds: delaySeconds } : undefined),
							}),
						),
					),
					Effect.flatMap((): Effect.Effect<MessageOutcome> =>
						isFinalAttempt
							? service
									.recordExhaustedFailure(message.body)
									.pipe(Effect.as({ id: message.id, outcome: "ack" }))
							: Effect.succeed(
									isDelaySecondsSet
										? { id: message.id, outcome: "retry", delaySeconds }
										: { id: message.id, outcome: "retry" },
								),
					),
				)
			},
			onSuccess: () =>
				Effect.annotateCurrentSpan({ "vcs.queue.message.outcome": "succeeded_ack" }).pipe(
					Effect.as<MessageOutcome>({ id: message.id, outcome: "ack" }),
				),
		}),
		Effect.withSpan("VcsSyncQueue.processMessage", {
			kind: "consumer",
			attributes: {
				"messaging.system": MESSAGING_SYSTEM,
				"messaging.destination.name": MESSAGING_DESTINATION,
				"messaging.operation.name": "process",
				"messaging.message.delivery_attempt": message.attempts,
			},
		}),
	)

const batchSpan = (messageCount: number, dispatch: "inline" | "placed") =>
	Effect.withSpan("VcsSyncQueue.processBatch", {
		kind: "consumer",
		attributes: {
			"messaging.system": MESSAGING_SYSTEM,
			"messaging.destination.name": MESSAGING_DESTINATION,
			"messaging.operation.name": "receive",
			"messaging.batch.message_count": messageCount,
			"maple.vcs.dispatch": dispatch,
		},
	})

/** The batch in this invocation, each message acked or retried as soon as it settles. */
export const processBatch = (batch: QueueBatch) =>
	Effect.gen(function* () {
		const service = yield* VcsSyncService
		yield* Effect.forEach(
			batch.messages,
			(message) =>
				settleMessage(service, toPlacedMessage(message)).pipe(
					Effect.flatMap((outcome) => applyOutcome(message, outcome)),
				),
			{ discard: true },
		)
	}).pipe(batchSpan(batch.messages.length, "inline"))

/** The batch in the placed fetch handler: the outcomes go back to the consumer that holds the messages. */
export const processPlacedBatch = (messages: ReadonlyArray<PlacedMessage>, placement: string) =>
	Effect.gen(function* () {
		const service = yield* VcsSyncService
		yield* Effect.annotateCurrentSpan("maple.placement", placement)
		return yield* Effect.forEach(messages, (message) => settleMessage(service, message))
	}).pipe(batchSpan(messages.length, "placed"))

/**
 * Final deliveries whose placed run failed with an unknown outcome: no redelivery is left, so the
 * terminal status is recorded and the message acked, as a failed final attempt inline would be.
 */
export const recordExhaustedBatch = (messages: ReadonlyArray<Message<unknown>>) =>
	Effect.gen(function* () {
		const service = yield* VcsSyncService
		yield* Effect.forEach(
			messages,
			(message) =>
				Effect.logError("[VCS] sync message exhausted after a failed placed run").pipe(
					Effect.annotateLogs({ attempt: message.attempts, outcome: "exhausted", exhausted: true }),
					Effect.andThen(service.recordExhaustedFailure(message.body)),
					Effect.andThen(Effect.sync(() => message.ack())),
				),
			{ discard: true },
		)
	}).pipe(
		Effect.withSpan("VcsSyncQueue.recordExhausted", {
			kind: "consumer",
			attributes: {
				"messaging.system": MESSAGING_SYSTEM,
				"messaging.destination.name": MESSAGING_DESTINATION,
				"messaging.operation.name": "settle",
				"messaging.batch.message_count": messages.length,
			},
		}),
	)
