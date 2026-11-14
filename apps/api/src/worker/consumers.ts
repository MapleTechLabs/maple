/**
 * The api Worker's queue consumers. Each processes its batch per message
 * (ack / retry are the consumer's decisions; the event source's batch ack
 * afterwards is ignored for a message already retried) over its own light
 * layer graph and one Postgres socket for the batch.
 */
import * as Cloudflare from "@alchemy.run/cloudflare"
import { Effect, Layer, Stream } from "effect"
import { DatabasePgLive } from "@maple/backend/platform/DatabasePgLive"
import { AuditEventsDlq, AuditEventsQueue } from "@maple/infra/cloudflare"
import {
	CancellationReviewsQueue,
	PlanetScaleWebhookQueue,
	VcsBackfillQueue,
	VcsSyncQueue,
} from "../resources/queues"
import type { ApiPortsLayer } from "./bindings"
import type { VcsSyncIsolateCaches } from "@maple/backend/services/integrations/vcs/vcs-sync-isolate-caches"
import { runEvent } from "./events"
import { auditEventsModule, cancellationReviewModule, planetScaleWebhookModule } from "./modules"
import { consumeVcsSyncBatch } from "./vcs-sync"
import { VCS_SYNC_BATCH_SIZE, VCS_SYNC_MAX_RETRIES } from "./vcs-sync-dispatch"

// Consumer settings. The audit and review runtimes take `maxRetries` from here to
// log the final attempt. The VCS one reads its constants from the batch route, which caps a request at them.
const VCS_SYNC_CONSUMER = {
	batchSize: VCS_SYNC_BATCH_SIZE,
	maxConcurrency: 2,
	maxRetries: VCS_SYNC_MAX_RETRIES,
	maxWaitTime: "5 seconds",
} satisfies Cloudflare.Queues.MessagesProps
const PLANETSCALE_WEBHOOKS_CONSUMER = VCS_SYNC_CONSUMER
// A review is up to a minute of upstream reads and one model call: one per
// invocation, few at once. The consumer sets each retry's delay.
const CANCELLATION_REVIEWS_CONSUMER = {
	batchSize: 1,
	maxConcurrency: 2,
	maxRetries: 5,
	maxWaitTime: "1 second",
} satisfies Cloudflare.Queues.MessagesProps
// Audit entries tolerate a few seconds of delivery latency; batch wider and
// wait longer so one insert round-trip covers many entries.
const AUDIT_EVENTS_CONSUMER = {
	batchSize: 25,
	maxConcurrency: 2,
	maxRetries: 5,
	maxWaitTime: "5 seconds",
} satisfies Cloudflare.Queues.MessagesProps

/**
 * Attaches the five consumers to the host at plan time and their listeners
 * at runtime. Needs `Queues.EventSourceLive`.
 */
export const registerQueueConsumers = (
	ports: ApiPortsLayer,
	env: Record<string, unknown>,
	vcsSyncCaches: VcsSyncIsolateCaches,
) =>
	Effect.gen(function* () {
		// Handed to the placed fetch handler over the self binding (`./vcs-sync.ts`), inline without it.
		const vcsSyncQueue = yield* VcsSyncQueue
		yield* Cloudflare.Queues.consumeQueueMessages(vcsSyncQueue, VCS_SYNC_CONSUMER, (stream) =>
			Effect.flatMap(Stream.runCollect(stream), (messages) =>
				consumeVcsSyncBatch(ports, env, vcsSyncCaches, messages),
			),
		)
		// Same handler, own consumer: a scheduled sync's backlog drains here without holding up webhooks.
		const vcsBackfillQueue = yield* VcsBackfillQueue
		yield* Cloudflare.Queues.consumeQueueMessages(vcsBackfillQueue, VCS_SYNC_CONSUMER, (stream) =>
			Effect.flatMap(Stream.runCollect(stream), (messages) =>
				consumeVcsSyncBatch(ports, env, vcsSyncCaches, messages),
			),
		)
		const planetScaleWebhookQueue = yield* PlanetScaleWebhookQueue
		yield* Cloudflare.Queues.consumeQueueMessages(
			planetScaleWebhookQueue,
			PLANETSCALE_WEBHOOKS_CONSUMER,
			(stream) =>
				Effect.flatMap(
					planetScaleWebhookModule,
					({ processPlanetScaleWebhookBatch, planetScaleWebhookTelemetry }) =>
						Effect.flatMap(Stream.runCollect(stream), (messages) =>
							runEvent(
								processPlanetScaleWebhookBatch({ messages }),
								DatabasePgLive.pipe(
									Layer.provideMerge(planetScaleWebhookTelemetry),
									Layer.provideMerge(ports),
								),
							),
						),
				),
		)
		const cancellationReviewsQueue = yield* CancellationReviewsQueue
		yield* Cloudflare.Queues.consumeQueueMessages(
			cancellationReviewsQueue,
			CANCELLATION_REVIEWS_CONSUMER,
			(stream) =>
				Effect.flatMap(
					cancellationReviewModule,
					({
						CancellationReviewLive,
						cancellationReviewTelemetry,
						processCancellationReviewBatch,
					}) =>
						Effect.flatMap(Stream.runCollect(stream), (messages) =>
							runEvent(
								processCancellationReviewBatch(
									{ messages },
									CANCELLATION_REVIEWS_CONSUMER.maxRetries,
								),
								CancellationReviewLive.pipe(
									Layer.provideMerge(cancellationReviewTelemetry),
									Layer.provideMerge(ports),
								),
							),
						),
				),
		)
		// The dead-letter setting is a plan-time value: the DLQ's resolved props
		// carry its physical name there and are empty in the isolate.
		const auditEventsDlq = yield* AuditEventsDlq
		const auditEventsQueue = yield* AuditEventsQueue
		yield* Cloudflare.Queues.consumeQueueMessages(
			auditEventsQueue,
			{ ...AUDIT_EVENTS_CONSUMER, deadLetterQueue: auditEventsDlq.Props.name },
			(stream) =>
				Effect.flatMap(auditEventsModule, ({ AuditEventsLive, processAuditEventsBatch }) =>
					Effect.flatMap(Stream.runCollect(stream), (messages) =>
						runEvent(
							processAuditEventsBatch({ messages }, AUDIT_EVENTS_CONSUMER.maxRetries),
							AuditEventsLive.pipe(Layer.provideMerge(ports)),
						),
					),
				),
		)
	})
