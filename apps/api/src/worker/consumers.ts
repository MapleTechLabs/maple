/**
 * The api Worker's queue consumers. Each processes its batch per message
 * (ack / retry are the consumer's decisions; the event source's batch ack
 * afterwards is ignored for a message already retried) over its own light
 * layer graph and one Postgres socket for the batch. The bridge builds the
 * telemetry into the batch's scope.
 */
import * as Cloudflare from "alchemy/Cloudflare"
import { renamedFrom } from "alchemy/Rename"
import { Effect, Layer, Stream } from "effect"
import { AuditEventsDlq, AuditEventsQueue, PlanetScaleWebhookQueue, VcsSyncQueue } from "../resources/queues"
import type { ApiPortsLayer } from "./bindings"
import { provideEvent } from "./events"
import { auditEventsModule, pgScopeModule, planetScaleWebhookModule, vcsSyncModule } from "./modules"

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
 * at runtime. Needs `Queues.EventSourceLive`. Yielding a queue declaration
 * here returns the registration the props made, at plan time; in the isolate
 * its attributes resolve from the env the plan bound. `renamedFrom` carries
 * the consumer resources over from the ids the api factory declared them
 * under, so the deploy migrates their state rows instead of re-creating the
 * consumers.
 */
export const registerQueueConsumers = (ports: ApiPortsLayer) =>
	Effect.gen(function* () {
		const pgScope = yield* Effect.cached(pgScopeModule)
		const vcsSync = yield* Effect.cached(vcsSyncModule)
		const planetScaleWebhooks = yield* Effect.cached(planetScaleWebhookModule)
		const auditEvents = yield* Effect.cached(auditEventsModule)

		yield* Cloudflare.Queues.consumeQueueMessages(yield* VcsSyncQueue, VCS_SYNC_CONSUMER, (stream) =>
			Effect.gen(function* () {
				const [{ buildVcsSyncLayer, processBatch, vcsSyncTelemetry }, { withPgConnectionScope }] =
					yield* Effect.all([vcsSync, pgScope])
				const messages = yield* Stream.runCollect(stream)
				yield* withPgConnectionScope(processBatch({ messages })).pipe(
					provideEvent(
						buildVcsSyncLayer().pipe(
							Layer.provideMerge(vcsSyncTelemetry),
							Layer.provideMerge(ports),
						),
					),
				)
			}),
		).pipe(renamedFrom({ fqn: "vcs-sync-consumer" }))
		yield* Cloudflare.Queues.consumeQueueMessages(
			yield* PlanetScaleWebhookQueue,
			PLANETSCALE_WEBHOOKS_CONSUMER,
			(stream) =>
				Effect.gen(function* () {
					const [
						{
							buildPlanetScaleWebhookLayer,
							processPlanetScaleWebhookBatch,
							planetScaleWebhookTelemetry,
						},
						{ withPgConnectionScope },
					] = yield* Effect.all([planetScaleWebhooks, pgScope])
					const messages = yield* Stream.runCollect(stream)
					yield* withPgConnectionScope(processPlanetScaleWebhookBatch({ messages })).pipe(
						provideEvent(
							buildPlanetScaleWebhookLayer().pipe(
								Layer.provideMerge(planetScaleWebhookTelemetry),
								Layer.provideMerge(ports),
							),
						),
					)
				}),
		).pipe(renamedFrom({ fqn: "planetscale-webhooks-consumer" }))
		// The dead-letter setting is a plan-time value: the DLQ's resolved props
		// carry its physical name there and are empty in the isolate, where the
		// consumer's settings play no part.
		const auditEventsDlq = yield* AuditEventsDlq
		yield* Cloudflare.Queues.consumeQueueMessages(
			yield* AuditEventsQueue,
			auditEventsConsumer(auditEventsDlq.Props.name),
			(stream) =>
				Effect.gen(function* () {
					const [{ buildAuditEventsLayer, processAuditEventsBatch }, { withPgConnectionScope }] =
						yield* Effect.all([auditEvents, pgScope])
					const messages = yield* Stream.runCollect(stream)
					yield* withPgConnectionScope(processAuditEventsBatch({ messages })).pipe(
						provideEvent(buildAuditEventsLayer().pipe(Layer.provideMerge(ports))),
					)
				}),
		).pipe(renamedFrom({ fqn: "audit-events-consumer" }))
	})
