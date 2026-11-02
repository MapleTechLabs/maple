import { eventTelemetry } from "@maple/infra/worker-telemetry"
import { Cause, Effect, Layer, Option, Schema } from "effect"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { EdgeCacheServiceLive } from "@maple/backend/platform/CacheBackendLive"
import { EventBaseLive } from "@maple/backend/platform/DatabasePgLive"
import type { QueueBatch } from "@maple/backend/platform/queue-batch"
import { CancellationReviewJob } from "@maple/backend/services/cancellation-review/CancellationReviewQueue"
import { CancellationReviewService } from "@maple/backend/services/cancellation-review/CancellationReviewService"

/** Not `maple-api`: a review's minute of upstream reads would skew the request service's percentiles. */
export const cancellationReviewTelemetry = eventTelemetry({ serviceName: "maple-cancellation-reviews" })

/**
 * The review and what it reads, over the env-backed `Env` and the database.
 * The ports (`AI_WORKER`, `MAPLE_DB`, config) come from the Worker.
 */
export const CancellationReviewLive = CancellationReviewService.layer.pipe(
	Layer.provide(Layer.mergeAll(EventBaseLive, EdgeCacheServiceLive)),
)

/**
 * Must match `maxRetries` on the cancellation-reviews consumer
 * (`worker/consumers.ts`). The attempt past it logs the drop and acks.
 */
const CANCELLATION_REVIEW_MAX_RETRIES = 5

/**
 * 1, 2, 4, 8, 16 minutes: about half an hour for Clerk, Autumn, Postgres or
 * Slack to come back. A review waiting out another delivery's claim (a
 * five-minute lease) spends three attempts at most.
 */
const retryDelaySeconds = (attempts: number) => 60 * 2 ** (attempts - 1)

const decodeJob = Schema.decodeUnknownEffect(CancellationReviewJob)

/** What became of a message, on its span, so a dropped review can be found by it. */
const settle = (outcome: "reviewed" | "retried" | "interrupted" | "dropped" | "malformed") =>
	Effect.annotateCurrentSpan({ "maple.cancellation.queue_outcome": outcome })

/**
 * The cancellation-reviews queue consumer: one review per message. A review
 * that could not finish retries with backoff; any outcome it reached acks. The
 * review's claim row dedupes queue redelivery and a cancellation queued twice.
 */
export const processCancellationReviewBatch = (batch: QueueBatch) =>
	Effect.gen(function* () {
		const reviews = yield* CancellationReviewService
		yield* Effect.forEach(
			batch.messages,
			(message) =>
				decodeJob(message.body).pipe(
					Effect.matchEffect({
						// Undecodable now means undecodable on every redelivery.
						onFailure: (error) =>
							Effect.logError("Discarding malformed cancellation review queue message").pipe(
								Effect.annotateLogs({ attempt: message.attempts, error: String(error) }),
								Effect.andThen(settle("malformed")),
								Effect.andThen(Effect.sync(() => message.ack())),
							),
						onSuccess: (job) =>
							reviews.review(job).pipe(
								// Any failure, a defect too, goes through the same backoff and drop log:
								// left to the batch, it would be retried at once until dropped unlogged.
								Effect.matchCauseEffect({
									onSuccess: () =>
										settle("reviewed").pipe(
											Effect.andThen(Effect.sync(() => message.ack())),
										),
									onFailure: (cause) => {
										// The Worker stopping mid-review is not the review failing: back at once.
										if (Cause.hasInterruptsOnly(cause)) {
											return settle("interrupted").pipe(
												Effect.andThen(Effect.sync(() => message.retry())),
											)
										}
										const details = {
											orgId: job.orgId,
											planId: job.planId,
											phase: job.phase,
											attempt: message.attempts,
											step: Option.match(Cause.findErrorOption(cause), {
												onNone: () => "defect",
												onSome: (error) => error.step,
											}),
											error: summarizeCause(cause),
										}
										return message.attempts > CANCELLATION_REVIEW_MAX_RETRIES
											? Effect.logError(
													"Cancellation review exhausted its retries; dropped",
												).pipe(
													Effect.annotateLogs(details),
													Effect.andThen(settle("dropped")),
													Effect.andThen(Effect.sync(() => message.ack())),
												)
											: Effect.logWarning(
													"Cancellation review did not finish; retrying",
												).pipe(
													Effect.annotateLogs(details),
													Effect.andThen(settle("retried")),
													Effect.andThen(
														Effect.sync(() =>
															message.retry({
																delaySeconds: retryDelaySeconds(
																	message.attempts,
																),
															}),
														),
													),
												)
									},
								}),
							),
					}),
					Effect.withSpan("CancellationReviewQueue.processMessage", {
						attributes: { "messaging.message.delivery_attempt": message.attempts },
					}),
				),
			{ discard: true },
		)
	})
