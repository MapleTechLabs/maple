import { eventTelemetry } from "@maple/infra/worker-telemetry"
import { Effect, Schema } from "effect"
import type { Database, DatabaseError } from "@/platform/DatabaseLive"
import type { QueueBatch } from "@/platform/queue-batch"
import {
	classifyPlanetScaleEvent,
	deployRequestNumber,
	insertPlanetScaleEvent,
	planetScaleBranchName,
	planetScaleWebhookPayloadFromEvent,
	projectPlanetScaleWebhookEvent,
	upsertPlanetScaleIssue,
} from "./services/integrations/planetscale/webhook-events"
import { PlanetScaleWebhookQueueMessage } from "./services/integrations/planetscale/PlanetScaleWebhookQueue"

/**
 * Deliberately not `maple-api`: background work sharing the request-facing
 * service's name skewed its percentiles (p99 32s, 2026-09-04). Provided by the
 * Worker around the event; the layer below carries no tracer of its own.
 */
export const planetScaleWebhookTelemetry = eventTelemetry({ serviceName: "maple-planetscale-webhooks" })

const decodeJob = Schema.decodeUnknownEffect(PlanetScaleWebhookQueueMessage)

export const processPlanetScaleWebhookBatch = (batch: QueueBatch) =>
	Effect.forEach(
		batch.messages,
		(message) =>
			decodeJob(message.body).pipe(
				Effect.matchEffect({
					onFailure: (error) =>
						Effect.logWarning("Discarding malformed PlanetScale webhook queue message").pipe(
							Effect.annotateLogs({
								attempt: message.attempts,
								error: String(error),
							}),
							Effect.flatMap(() => Effect.sync(() => message.ack())),
							Effect.tap(() =>
								Effect.annotateCurrentSpan({
									"maple.planetscale.webhook.queue.outcome": "malformed_ack",
								}),
							),
						),
					onSuccess: (job) =>
						Effect.gen(function* () {
							// Old jobs can remain in Cloudflare Queue across a deploy. Rebuild the
							// event from the durable legacy fields instead of malformed-acking them.
							const event =
								"event" in job
									? job.event
									: yield* Effect.fromResult(
											projectPlanetScaleWebhookEvent({
												orgId: job.orgId,
												connectionId: job.connectionId,
												payload: job.payload,
												receivedAt: job.receivedAt,
											}),
										)
							const payload =
								"event" in job
									? yield* Effect.fromResult(
											planetScaleWebhookPayloadFromEvent(
												event,
												job.orgId,
												job.connectionId,
											),
										)
									: job.payload
							const classified = classifyPlanetScaleEvent(payload.event)
							const annotateJob = Effect.annotateCurrentSpan({
								orgId: job.orgId,
								"maple.event.id": event.id,
								"maple.event.type": event.type,
								"maple.planetscale.connection_id": job.connectionId,
								"maple.planetscale.webhook.event": payload.event,
							})
							if (classified.action !== "issue" && classified.action !== "timeline") {
								return yield* annotateJob.pipe(
									Effect.flatMap(() =>
										Effect.logInfo(
											"PlanetScale webhook queue message no longer requires persistence",
										),
									),
									Effect.annotateLogs({
										orgId: job.orgId,
										connectionId: job.connectionId,
										event: payload.event,
									}),
									Effect.flatMap(() => Effect.sync(() => message.ack())),
								)
							}

							const timestamp =
								payload.timestamp != null && payload.timestamp > 0
									? payload.timestamp * 1000
									: job.receivedAt

							const spec = classified.timeline
							const timeline = insertPlanetScaleEvent({
								orgId: job.orgId,
								databaseName: payload.database ?? "unknown",
								branchName:
									spec.category === "deploy_request" ? "" : planetScaleBranchName(payload),
								category: spec.category,
								eventType: payload.event,
								state: spec.state,
								externalId:
									spec.category === "deploy_request" ? deployRequestNumber(payload) : "",
								title: spec.title(payload),
								source: "webhook",
								payload: payload.resource ?? null,
								occurredAtMs: timestamp,
								createdAtMs: job.receivedAt,
							}).pipe(
								Effect.withSpan("PlanetScaleWebhookQueue.persistTimelineEvent", {
									attributes: {
										orgId: job.orgId,
										"maple.planetscale.webhook.event": payload.event,
									},
								}),
							)

							// Timeline first: a retry after a failed issue upsert then re-runs
							// an idempotent insert rather than duplicating a chart marker.
							const persist: Effect.Effect<
								{ readonly issueId: string | null; readonly action: string },
								DatabaseError,
								Database
							> =
								classified.action === "timeline"
									? timeline.pipe(Effect.as({ issueId: null, action: "timeline" }))
									: timeline.pipe(
											Effect.flatMap(() =>
												upsertPlanetScaleIssue({
													orgId: job.orgId,
													eventId: event.id,
													payload,
													severity: classified.severity,
													title: classified.title,
													description: classified.describe(payload),
													timestamp,
												}),
											),
											Effect.withSpan("PlanetScaleWebhookQueue.persistIssue", {
												attributes: {
													orgId: job.orgId,
													"maple.planetscale.connection_id": job.connectionId,
													"maple.planetscale.webhook.event": payload.event,
												},
											}),
										)
							return yield* annotateJob.pipe(
								Effect.flatMap(() => persist),
								Effect.matchEffect({
									onFailure: (error) =>
										Effect.logError("PlanetScale webhook persistence failed").pipe(
											Effect.annotateLogs({
												orgId: job.orgId,
												connectionId: job.connectionId,
												event: payload.event,
												attempt: message.attempts,
												error: error.message,
											}),
											Effect.flatMap(() => Effect.sync(() => message.retry())),
											Effect.tap(() =>
												Effect.annotateCurrentSpan({
													"maple.planetscale.webhook.queue.outcome":
														"database_retry",
												}),
											),
										),
									onSuccess: (result) =>
										Effect.logInfo("PlanetScale webhook persisted").pipe(
											Effect.annotateLogs({
												orgId: job.orgId,
												connectionId: job.connectionId,
												event: payload.event,
												issueId: result.issueId,
												issueAction: result.action,
											}),
											Effect.flatMap(() => Effect.sync(() => message.ack())),
											Effect.tap(() =>
												Effect.annotateCurrentSpan({
													"maple.planetscale.webhook.queue.outcome":
														result.action === "timeline"
															? "timeline_ack"
															: "timeline_and_issue_ack",
													"maple.planetscale.webhook.issue_action": result.action,
												}),
											),
										),
								}),
							)
						}).pipe(
							Effect.catchTag(
								"@maple/api/planetscale/PlanetScaleWebhookProjectionInvalid",
								(error) =>
									Effect.logWarning(error.message).pipe(
										Effect.annotateLogs({
											errorTag: error._tag,
											cause: error.cause,
											orgId: error.orgId,
											connectionId: error.connectionId,
										}),
										Effect.andThen(Effect.sync(() => message.ack())),
										Effect.tap(() =>
											Effect.annotateCurrentSpan({
												"maple.planetscale.webhook.queue.outcome": "malformed_ack",
											}),
										),
									),
							),
						),
				}),
				Effect.withSpan("PlanetScaleWebhookQueue.processMessage", {
					attributes: { "messaging.message.delivery_attempt": message.attempts },
				}),
			),
		{ concurrency: 5, discard: true },
	).pipe(
		Effect.withSpan("PlanetScaleWebhookQueue.processBatch", {
			attributes: { "messaging.batch.message_count": batch.messages.length },
		}),
	)
