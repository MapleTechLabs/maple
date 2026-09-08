import { Result } from "effect"
import { assert, describe, it } from "@effect/vitest"
import { OrgId } from "@maple/domain/http"
import { PlanetScaleWebhookQueueProducer, type QueueProducer, QueueSendError } from "@/platform/bindings"
import { Effect, Layer, Schema } from "effect"
import { projectPlanetScaleWebhookEvent as projectPlanetScaleWebhookEventResult } from "./webhook-events"
import {
	MAX_PLANETSCALE_WEBHOOK_QUEUE_BYTES,
	PlanetScaleWebhookQueue,
	PlanetScaleWebhookQueueMessage,
	planetScaleWebhookQueueJobBytes,
	preparePlanetScaleWebhookJob,
	type PlanetScaleWebhookJob,
} from "./PlanetScaleWebhookQueue"

const projectPlanetScaleWebhookEvent = (...args: Parameters<typeof projectPlanetScaleWebhookEventResult>) =>
	Result.getOrThrow(projectPlanetScaleWebhookEventResult(...args))

const orgId = Schema.decodeUnknownSync(OrgId)("org_1")
const payload = {
	timestamp: 1,
	event: "branch.anomaly",
	organization: "acme",
	database: "shop",
	resource: { name: "main" },
}
const job: PlanetScaleWebhookJob = {
	kind: "planetscale-webhook",
	orgId,
	connectionId: "connection_1",
	receivedAt: 1_000,
	event: projectPlanetScaleWebhookEvent({
		orgId,
		connectionId: "connection_1",
		payload,
		receivedAt: 1_000,
	}),
}

const provideQueue = (producer: QueueProducer) =>
	Effect.provide(
		PlanetScaleWebhookQueue.layer.pipe(
			Layer.provide(Layer.succeed(PlanetScaleWebhookQueueProducer, producer)),
		),
	)

describe("PlanetScaleWebhookQueue", () => {
	it("decodes tenant, source, connection, type, schema, and time as one relational boundary", () => {
		const contradictions: readonly PlanetScaleWebhookJob[] = [
			{ ...job, event: { ...job.event, tenantid: Schema.decodeUnknownSync(OrgId)("org_2") } },
			{ ...job, event: { ...job.event, source: "urn:maple:planetscale:connection_2" } },
			{
				...job,
				event: {
					...job.event,
					data: {
						connectionId: "connection_2",
						event: payload.event,
						organization: payload.organization,
						database: payload.database,
						resource: payload.resource,
					},
				},
			},
			{ ...job, event: { ...job.event, type: "dev.maple.unsupported.v1" } },
			{ ...job, event: { ...job.event, dataschema: "urn:maple:event-schema:unsupported:v1" } },
			{ ...job, event: { ...job.event, time: "2026-99-99T00:00:00Z" } },
		]
		for (const contradiction of contradictions)
			assert.throws(() => Schema.decodeUnknownSync(PlanetScaleWebhookQueueMessage)(contradiction))
		assert.deepStrictEqual(Schema.decodeUnknownSync(PlanetScaleWebhookQueueMessage)(job), job)
	})

	it.effect("schema-encodes the internal job onto the dedicated binding", () => {
		const sent: unknown[] = []
		assert.isBelow(planetScaleWebhookQueueJobBytes(job), MAX_PLANETSCALE_WEBHOOK_QUEUE_BYTES)
		return Effect.gen(function* () {
			const queue = yield* PlanetScaleWebhookQueue
			yield* queue.send(preparePlanetScaleWebhookJob(job))
			assert.deepStrictEqual(sent, [job])
		}).pipe(
			provideQueue({
				sendBatch: (messages) =>
					Effect.sync(() => {
						for (const message of messages) sent.push(message.body)
					}),
			}),
		)
	})

	it.effect("maps binding rejections to the typed queue error", () => {
		let attempts = 0
		return Effect.gen(function* () {
			const queue = yield* PlanetScaleWebhookQueue
			const error = yield* queue.send(preparePlanetScaleWebhookJob(job)).pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/api/services/planetscale/PlanetScaleWebhookQueueError")
			assert.strictEqual(error.message, "simulated queue outage")
			assert.strictEqual(attempts, 1)
		}).pipe(
			provideQueue({
				sendBatch: () =>
					Effect.sync(() => {
						attempts += 1
					}).pipe(
						Effect.andThen(
							Effect.fail(
								new QueueSendError({ message: "simulated queue outage", cause: undefined }),
							),
						),
					),
			}),
		)
	})

	it.effect("accepts the serialized cap and rejects one byte above it", () => {
		let attempts = 0
		const withPayload = (payload: string): PlanetScaleWebhookJob => ({
			...job,
			event: {
				...job.event,
				data: { payload },
			},
		})
		const empty = withPayload("")
		const envelopeBytes = planetScaleWebhookQueueJobBytes(empty)
		const atCap = withPayload("x".repeat(MAX_PLANETSCALE_WEBHOOK_QUEUE_BYTES - envelopeBytes))
		const oversized = withPayload("x".repeat(MAX_PLANETSCALE_WEBHOOK_QUEUE_BYTES - envelopeBytes + 1))
		assert.strictEqual(planetScaleWebhookQueueJobBytes(atCap), MAX_PLANETSCALE_WEBHOOK_QUEUE_BYTES)
		assert.strictEqual(
			planetScaleWebhookQueueJobBytes(oversized),
			MAX_PLANETSCALE_WEBHOOK_QUEUE_BYTES + 1,
		)
		return Effect.gen(function* () {
			const queue = yield* PlanetScaleWebhookQueue
			yield* queue.send(preparePlanetScaleWebhookJob(atCap))
			const error = yield* queue.send(preparePlanetScaleWebhookJob(oversized)).pipe(Effect.flip)
			assert.match(error.message, /queue job exceeds/)
			assert.strictEqual(attempts, 1)
		}).pipe(
			provideQueue({
				sendBatch: () =>
					Effect.sync(() => {
						attempts += 1
					}),
			}),
		)
	})
})
