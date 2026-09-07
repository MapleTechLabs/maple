/**
 * The api Worker's queue consumers. Each processes its batch per message
 * (ack / retry are the consumer's decisions; the event source's batch ack
 * afterwards is ignored for a message already retried) over its own light
 * layer graph and one Postgres socket for the batch.
 */
import * as Cloudflare from "alchemy/Cloudflare"
import { renamedFrom } from "alchemy/Rename"
import { Effect, Layer, Stream } from "effect"
import { AuditEventsDlq, AuditEventsQueue, PlanetScaleWebhookQueue, VcsSyncQueue } from "../resources/queues"
import type { ApiPortsLayer } from "./bindings"
import { runEvent } from "./events"
import { auditEventsModule, planetScaleWebhookModule, vcsSyncModule } from "./modules"

// Consumer settings. The audit consumer's `maxRetries` must stay in sync with
// AUDIT_EVENTS_MAX_RETRIES in audit-events-runtime.ts, which logs the drop on
// the final attempt; the VCS one with VCS_SYNC_MAX_RETRIES in vcs-sync-runtime.ts.
const VCS_SYNC_CONSUMER = {
	batchSize: 10,
	maxConcurrency: 2,
	maxRetries: 3,
	maxWaitTime: "5 seconds",
} satisfies Cloudflare.Queues.MessagesProps
const PLANETSCALE_WEBHOOKS_CONSUMER = VCS_SYNC_CONSUMER
// Audit entries tolerate a few seconds of delivery latency; batch wider and
// wait longer so one insert round-trip covers many entries.
const auditEventsConsumer = (deadLetterQueue: string | undefined): Cloudflare.Queues.MessagesProps => ({
	batchSize: 25,
	maxConcurrency: 2,
	maxRetries: 5,
	maxWaitTime: "5 seconds",
	deadLetterQueue,
})

/**
 * Attaches the three consumers to the host at plan time and their listeners
 * at runtime. Needs `Queues.EventSourceLive`. `renamedFrom` carries the
 * consumer resources over from the ids the api factory declared them under,
 * so the deploy migrates their state rows instead of re-creating the
 * consumers; drop it once every stage has deployed past it.
 */
export const registerQueueConsumers = (ports: ApiPortsLayer) =>
	Effect.gen(function* () {
		yield* Cloudflare.Queues.consumeQueueMessages(yield* VcsSyncQueue, VCS_SYNC_CONSUMER, (stream) =>
			Effect.flatMap(vcsSyncModule, ({ VcsSyncLive, processBatch, vcsSyncTelemetry }) =>
				Effect.flatMap(Stream.runCollect(stream), (messages) =>
					runEvent(
						processBatch({ messages }),
						VcsSyncLive.pipe(Layer.provideMerge(vcsSyncTelemetry), Layer.provideMerge(ports)),
					),
				),
			),
		).pipe(renamedFrom({ fqn: "vcs-sync-consumer" }))
		yield* Cloudflare.Queues.consumeQueueMessages(
			yield* PlanetScaleWebhookQueue,
			PLANETSCALE_WEBHOOKS_CONSUMER,
			(stream) =>
				Effect.flatMap(
					planetScaleWebhookModule,
					({
						PlanetScaleWebhookLive,
						processPlanetScaleWebhookBatch,
						planetScaleWebhookTelemetry,
					}) =>
						Effect.flatMap(Stream.runCollect(stream), (messages) =>
							runEvent(
								processPlanetScaleWebhookBatch({ messages }),
								PlanetScaleWebhookLive.pipe(
									Layer.provideMerge(planetScaleWebhookTelemetry),
									Layer.provideMerge(ports),
								),
							),
						),
				),
		).pipe(renamedFrom({ fqn: "planetscale-webhooks-consumer" }))
		// The dead-letter setting is a plan-time value: the DLQ's resolved props
		// carry its physical name there and are empty in the isolate.
		const auditEventsDlq = yield* AuditEventsDlq
		yield* Cloudflare.Queues.consumeQueueMessages(
			yield* AuditEventsQueue,
			auditEventsConsumer(auditEventsDlq.Props.name),
			(stream) =>
				Effect.flatMap(auditEventsModule, ({ AuditEventsLive, processAuditEventsBatch }) =>
					Effect.flatMap(Stream.runCollect(stream), (messages) =>
						runEvent(
							processAuditEventsBatch({ messages }),
							AuditEventsLive.pipe(Layer.provideMerge(ports)),
						),
					),
				),
		).pipe(renamedFrom({ fqn: "audit-events-consumer" }))
	})
