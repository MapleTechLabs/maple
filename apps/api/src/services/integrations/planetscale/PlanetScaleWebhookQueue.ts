import { OrgId } from "@maple/domain/http"
import { Context, Effect, Layer, Schema } from "effect"
import { PlanetScaleWebhookQueueProducer } from "@/platform/bindings"
import { PlanetScaleWebhookPayload } from "./webhook-events"

export const PlanetScaleWebhookJob = Schema.Struct({
	kind: Schema.Literal("planetscale-webhook"),
	orgId: OrgId,
	connectionId: Schema.String,
	payload: PlanetScaleWebhookPayload,
	receivedAt: Schema.Number,
})
export type PlanetScaleWebhookJob = Schema.Schema.Type<typeof PlanetScaleWebhookJob>

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
			yield* queue
				.send(encodeJob(job))
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
