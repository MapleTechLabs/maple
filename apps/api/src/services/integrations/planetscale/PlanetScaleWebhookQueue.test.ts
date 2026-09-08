import { assert, describe, it } from "@effect/vitest"
import { PlanetScaleWebhookQueueProducer, type QueueProducer, QueueSendError } from "@/platform/bindings"
import { Effect, Layer } from "effect"
import { PlanetScaleWebhookQueue, type PlanetScaleWebhookJob } from "./PlanetScaleWebhookQueue"

const job: PlanetScaleWebhookJob = {
	kind: "planetscale-webhook",
	orgId: "org_1",
	connectionId: "connection_1",
	payload: {
		event: "branch.anomaly",
		organization: "acme",
		database: "shop",
		resource: { name: "main" },
	},
	receivedAt: 1_000,
}

const provideQueue = (producer: QueueProducer) =>
	Effect.provide(
		PlanetScaleWebhookQueue.layer.pipe(
			Layer.provide(Layer.succeed(PlanetScaleWebhookQueueProducer, producer)),
		),
	)

describe("PlanetScaleWebhookQueue", () => {
	it.effect("schema-encodes the internal job onto the dedicated binding", () => {
		const sent: unknown[] = []
		return Effect.gen(function* () {
			const queue = yield* PlanetScaleWebhookQueue
			yield* queue.send(job)
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
			const error = yield* queue.send(job).pipe(Effect.flip)
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
})
