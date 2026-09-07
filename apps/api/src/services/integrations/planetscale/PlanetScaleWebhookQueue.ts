import { OrgId } from "@maple/domain/http"
import { PlanetScaleWebhookQueueProducer } from "@/platform/bindings"
import { MapleCloudEventSchema } from "@maple/eventing-core"
import { Context, Effect, Layer, Schema } from "effect"
import { PlanetScaleWebhookPayload, planetScaleWebhookPayloadFromEvent } from "./webhook-events"

const PlanetScaleWebhookJobBase = {
	kind: Schema.Literal("planetscale-webhook"),
	orgId: OrgId,
	connectionId: Schema.String,
	receivedAt: Schema.Number,
} as const

/** Exact queue body emitted before the typed CloudEvent migration. */
export const LegacyPlanetScaleWebhookJob = Schema.Struct({
	...PlanetScaleWebhookJobBase,
	payload: PlanetScaleWebhookPayload,
})

/** Current producer contract. New writers queue only the canonical event. */
export const PlanetScaleWebhookJob = Schema.Struct({
	...PlanetScaleWebhookJobBase,
	event: MapleCloudEventSchema,
})
export type PlanetScaleWebhookJob = Schema.Schema.Type<typeof PlanetScaleWebhookJob>

/** Consumer contract kept backward-compatible during rolling deployments. */
const PlanetScaleWebhookQueueMessageBase = Schema.Union([
	PlanetScaleWebhookJob,
	Schema.Struct({
		...PlanetScaleWebhookJobBase,
		payload: PlanetScaleWebhookPayload,
		event: MapleCloudEventSchema,
	}),
	LegacyPlanetScaleWebhookJob,
])
export const PlanetScaleWebhookQueueMessage = PlanetScaleWebhookQueueMessageBase.pipe(
	Schema.check(
		Schema.makeFilter(
			(job) => {
				if (!("event" in job)) return true
				try {
					planetScaleWebhookPayloadFromEvent(job.event, job.orgId, job.connectionId)
					return true
				} catch {
					return false
				}
			},
			{ expected: "a supported, tenant-bound PlanetScale webhook event" },
		),
	),
)
export type PlanetScaleWebhookQueueMessage = Schema.Schema.Type<typeof PlanetScaleWebhookQueueMessage>

/** Cloudflare's 128 KB body limit includes the complete serialized queue job. */
export const MAX_PLANETSCALE_WEBHOOK_QUEUE_BYTES = 120 * 1024

export class PlanetScaleWebhookQueueError extends Schema.TaggedError<PlanetScaleWebhookQueueError>()(
	"@maple/api/services/planetscale/PlanetScaleWebhookQueueError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

export interface PlanetScaleWebhookQueueApi {
	readonly send: (job: PlanetScaleWebhookJob) => Effect.Effect<void, PlanetScaleWebhookQueueError>
}

const encodeJob = Schema.encodeSync(PlanetScaleWebhookJob)

export const planetScaleWebhookQueueJobBytes = (job: PlanetScaleWebhookJob): number =>
	new TextEncoder().encode(JSON.stringify(encodeJob(job))).byteLength

/** Schema-encodes internal jobs onto the dedicated queue (`PlanetScaleWebhookQueueProducer`). */
export class PlanetScaleWebhookQueue extends Context.Service<
	PlanetScaleWebhookQueue,
	PlanetScaleWebhookQueueApi
>()("@maple/api/services/planetscale/PlanetScaleWebhookQueue", {
	make: Effect.gen(function* () {
		const queue = yield* PlanetScaleWebhookQueueProducer

		const send = Effect.fn("PlanetScaleWebhookQueue.send")(function* (job: PlanetScaleWebhookJob) {
			yield* Effect.annotateCurrentSpan({
				"maple.planetscale.webhook.job.kind": job.kind,
				orgId: job.orgId,
			})
			const encodedBytes = planetScaleWebhookQueueJobBytes(job)
			if (encodedBytes > MAX_PLANETSCALE_WEBHOOK_QUEUE_BYTES)
				return yield* new PlanetScaleWebhookQueueError({
					message: `PlanetScale queue job exceeds ${MAX_PLANETSCALE_WEBHOOK_QUEUE_BYTES} bytes`,
				})
			yield* queue
				.sendBatch([{ body: encodeJob(job) }])
				.pipe(
					Effect.mapError(
						(error) =>
							new PlanetScaleWebhookQueueError({ message: error.message, cause: error.cause }),
					),
				)
		})

		return { send } satisfies PlanetScaleWebhookQueueApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
