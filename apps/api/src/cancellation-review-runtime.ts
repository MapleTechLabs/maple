import { EdgeCacheServiceLive } from "@maple/backend/platform/CacheBackendLive"
import { eventTelemetry } from "@maple/infra/worker-telemetry"
import { Effect, Layer, Schema } from "effect"
import { EventBaseLive } from "@maple/backend/platform/DatabasePgLive"
import type { QueueBatch } from "@maple/backend/platform/queue-batch"
import { CancellationReviewJob } from "@maple/backend/services/cancellation-review/CancellationReviewQueue"
import { CancellationReviewService } from "@maple/backend/services/cancellation-review/CancellationReviewService"

/** Its own service name, like the other consumers: background work must not skew `maple-api`'s percentiles. */
export const cancellationReviewTelemetry = eventTelemetry({ serviceName: "maple-cancellation-reviews" })

// Per-invocation runtime for the cancellation-review queue, independent of the
// HTTP graph. The Worker env, its `ConfigProvider` and the binding ports come
// from the Worker (`apiPorts`), provided around the event.
export const CancellationReviewLive = CancellationReviewService.layer.pipe(
	Layer.provide(Layer.mergeAll(EventBaseLive, EdgeCacheServiceLive)),
)

const decodeJob = Schema.decodeUnknownEffect(CancellationReviewJob)

export const processCancellationReviewBatch = (batch: QueueBatch) =>
	Effect.forEach(
		batch.messages,
		(message) =>
			decodeJob(message.body).pipe(
				Effect.matchEffect({
					onFailure: (error) =>
						Effect.logWarning("Discarding malformed cancellation review queue message").pipe(
							Effect.annotateLogs({ attempt: message.attempts, error: String(error) }),
							Effect.andThen(Effect.sync(() => message.ack())),
						),
					onSuccess: (job) =>
						CancellationReviewService.use((service) => service.review(job)).pipe(
							Effect.matchEffect({
								onFailure: (error) =>
									Effect.logError("Cancellation review failed").pipe(
										Effect.annotateLogs({
											orgId: job.orgId,
											step: error.step,
											attempt: message.attempts,
											error: error.message,
										}),
										Effect.andThen(Effect.sync(() => message.retry())),
									),
								onSuccess: (outcome) =>
									Effect.logInfo("Cancellation review settled").pipe(
										Effect.annotateLogs({ orgId: job.orgId, outcome }),
										Effect.andThen(Effect.sync(() => message.ack())),
									),
							}),
						),
				}),
				Effect.withSpan("CancellationReviewQueue.processMessage", {
					attributes: { "messaging.message.delivery_attempt": message.attempts },
				}),
			),
		{ discard: true },
	)
