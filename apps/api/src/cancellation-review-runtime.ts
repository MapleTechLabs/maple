import { EdgeCacheServiceLive } from "@maple/backend/platform/CacheBackendLive"
import { eventTelemetry } from "@maple/infra/worker-telemetry"
import { Cause, Effect, Layer, Option, Schema } from "effect"
import { EventBaseLive } from "@maple/backend/platform/DatabasePgLive"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import type { QueueBatch } from "@maple/backend/platform/queue-batch"
import {
	CancellationReviewJob,
	MESSAGING_DESTINATION,
	MESSAGING_SYSTEM,
} from "@maple/backend/services/cancellation-review/CancellationReviewQueue"
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

/**
 * Must match `maxRetries` on the cancellation-reviews consumer in
 * `worker/consumers.ts`. Cloudflare discards the message after this many
 * retries without telling us, so the last attempt is where the loss is said.
 */
const CANCELLATION_REVIEWS_MAX_RETRIES = 5

const settle = (outcome: string) =>
	Effect.annotateCurrentSpan({ "maple.cancellation.queue.outcome": outcome })

export const processCancellationReviewBatch = (batch: QueueBatch) =>
	Effect.gen(function* () {
		const reviews = yield* CancellationReviewService
		yield* Effect.forEach(
			batch.messages,
			(message) =>
				decodeJob(message.body).pipe(
					Effect.matchEffect({
						// Nothing a retry could fix, and the cancellation it stood for is lost.
						onFailure: (error) =>
							Effect.logError("Discarding malformed cancellation review queue message").pipe(
								Effect.annotateLogs({ attempt: message.attempts, error: String(error) }),
								Effect.andThen(settle("malformed_ack")),
								Effect.andThen(Effect.sync(() => message.ack())),
							),
						onSuccess: (job) =>
							Effect.annotateCurrentSpan({
								orgId: job.orgId,
								"maple.cancellation.plan_id": job.planId,
							}).pipe(
								Effect.andThen(reviews.review(job)),
								// The whole cause: a defect must reach the same retry and the
								// same last-attempt log as an upstream that did not answer.
								Effect.matchCauseEffect({
									onFailure: (cause) => {
										if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
										const abandoned = message.attempts > CANCELLATION_REVIEWS_MAX_RETRIES
										const details = Effect.annotateLogs({
											orgId: job.orgId,
											planId: job.planId,
											step:
												Option.getOrUndefined(Cause.findErrorOption(cause))?.step ??
												"defect",
											attempt: message.attempts,
											error: summarizeCause(cause),
										})
										return (
											abandoned
												? Effect.logError(
														"Cancellation review abandoned after its last retry; no report was posted",
													)
												: Effect.logWarning("Cancellation review failed; retrying")
										).pipe(
											details,
											Effect.andThen(settle(abandoned ? "abandoned" : "retry")),
											Effect.andThen(Effect.sync(() => message.retry())),
										)
									},
									onSuccess: (outcome) =>
										Effect.logInfo("Cancellation review settled").pipe(
											Effect.annotateLogs({ orgId: job.orgId, outcome }),
											Effect.andThen(settle(`${outcome}_ack`)),
											Effect.andThen(Effect.sync(() => message.ack())),
										),
								}),
							),
					}),
					Effect.withSpan("CancellationReviewQueue.processMessage", {
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
	})
