import { EdgeCacheServiceLive } from "@maple/backend/platform/CacheBackendLive"
import { eventTelemetry } from "@maple/infra/worker-telemetry"
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
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import type { QueueBatch } from "@maple/backend/platform/queue-batch"

// Per-invocation runtime for the VCS sync queue, independent of the HTTP graph.
// No tracer or logger of its own: the Worker provides `vcsSyncTelemetry` around
// the event, and a layer here that carried one would shadow it. The Worker env,
// its `ConfigProvider` and the binding ports come from the Worker too
// (`apiPorts`), provided around the event.

/**
 * Deliberately not `maple-api`: background work sharing the request-facing
 * service's name skewed its percentiles (p99 32s, 2026-09-04).
 */
export const vcsSyncTelemetry = eventTelemetry({ serviceName: "maple-vcs-sync" })

// One delivery, two readers: the issue link / verification window, and the
// review trigger. Each is isolated in the fan-out so a defect in
// one never costs the other the event.
const PullRequestEventSinkLive = pullRequestEventSinkFanout<IssueFixVerificationService | PrReviewService>([
	{ name: "fix-verification", handler: fixVerificationPullRequestHandler },
	{ name: "pr-review", handler: prReviewPullRequestHandler },
]).pipe(
	Layer.provide(IssueFixVerificationService.layer),
	// The review trigger re-enqueues a push to debounce it, so it gets the queue here.
	Layer.provide(PrReviewService.layer.pipe(Layer.provide(VcsSyncQueue.layer))),
	Layer.provide(PullRequestLookup.none),
)

export const VcsSyncLive = VcsSyncService.layer.pipe(
	Layer.provide(PullRequestEventSinkLive),
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

// Must match the consumer's `maxRetries` in worker.ts. No DLQ exists, so on the
// final delivery (attempt > max_retries) we persist a terminal status instead of silently dropping.
const VCS_SYNC_MAX_RETRIES = 3

export const processBatch = (batch: QueueBatch) =>
	Effect.gen(function* () {
		const service = yield* VcsSyncService
		yield* Effect.forEach(
			batch.messages,
			(message) =>
				service.processMessage(message.body).pipe(
					Effect.matchCauseEffect({
						onFailure: (cause) => {
							// Rate-limited: delay redelivery until the VCS budget resets instead of retrying immediately.
							const failure = Option.getOrUndefined(Cause.findErrorOption(cause))
							const isRateLimited = failure?._tag === "@maple/http/errors/VcsRateLimitedError"

							const delaySeconds = isRateLimited
								? clampQueueDelaySeconds(failure.retryAfterSeconds)
								: undefined
							const isDelaySecondsSet = delaySeconds !== undefined
							// Last retry exhausted: persist terminal status so repos don't get stuck backfilling, then ack.
							const isFinalAttempt = message.attempts > VCS_SYNC_MAX_RETRIES

							// Low-cardinality outcome label — full Cause stays in the log, not the span.
							const outcome = isFinalAttempt
								? "exhausted"
								: isDelaySecondsSet
									? "retry_delayed"
									: "retry"

							return Effect.annotateCurrentSpan({
								"vcs.queue.message.outcome": outcome,
								// Tag rate-limit errors so `retry_delayed`/`exhausted` spans are filterable without parsing logs.
								...(isRateLimited
									? {
											"vcs.queue.failure.tag": "@maple/http/errors/VcsRateLimitedError",
										}
									: undefined),
								...(isDelaySecondsSet
									? { "vcs.queue.retry.delay_seconds": delaySeconds }
									: undefined),
							}).pipe(
								Effect.flatMap(() =>
									Effect.logError("[VCS] sync message failed").pipe(
										Effect.annotateLogs({
											error: summarizeCause(cause),
											attempt: message.attempts,
											outcome,
											...(isFinalAttempt ? { exhausted: true } : undefined),
											...(isDelaySecondsSet
												? { retryDelaySeconds: delaySeconds }
												: undefined),
										}),
									),
								),
								Effect.flatMap(() =>
									isFinalAttempt
										? service
												.recordExhaustedFailure(message.body)
												.pipe(Effect.flatMap(() => Effect.sync(() => message.ack())))
										: Effect.sync(() =>
												isDelaySecondsSet
													? message.retry({ delaySeconds })
													: message.retry(),
											),
								),
							)
						},
						onSuccess: () =>
							Effect.annotateCurrentSpan({
								"vcs.queue.message.outcome": "succeeded_ack",
							}).pipe(Effect.flatMap(() => Effect.sync(() => message.ack()))),
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
				),
			{ discard: true },
		)
	}).pipe(
		Effect.withSpan("VcsSyncQueue.processBatch", {
			kind: "consumer",
			attributes: {
				"messaging.system": MESSAGING_SYSTEM,
				"messaging.destination.name": MESSAGING_DESTINATION,
				"messaging.operation.name": "receive",
				"messaging.batch.message_count": batch.messages.length,
			},
		}),
	)
