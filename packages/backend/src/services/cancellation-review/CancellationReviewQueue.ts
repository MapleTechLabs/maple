import { CancellationPhase, OrgId } from "@maple/domain/http"
import { Context, Effect, Layer, Schema } from "effect"
import { CancellationReviewQueueProducer, type QueueSendError } from "@maple/backend/platform/bindings"

/**
 * One cancelled subscription, as the Autumn webhook saw it. The lifecycle
 * timestamps ride along because Autumn's customer read does not return them.
 */
export const CancellationReviewJob = Schema.Struct({
	kind: Schema.Literal("cancellation-review"),
	orgId: OrgId,
	planId: Schema.String,
	phase: CancellationPhase,
	/** Epoch ms, as Autumn sent them. */
	startedAt: Schema.NullOr(Schema.Number),
	canceledAt: Schema.NullOr(Schema.Number),
	expiresAt: Schema.NullOr(Schema.Number),
	trial: Schema.Boolean,
	pastDue: Schema.Boolean,
	receivedAt: Schema.Number,
})
export type CancellationReviewJob = Schema.Schema.Type<typeof CancellationReviewJob>

const encodeJob = Schema.encodeSync(CancellationReviewJob)

export interface CancellationReviewQueueApi {
	readonly send: (job: CancellationReviewJob) => Effect.Effect<void, QueueSendError>
}

export class CancellationReviewQueue extends Context.Service<
	CancellationReviewQueue,
	CancellationReviewQueueApi
>()("@maple/backend/cancellation-review/CancellationReviewQueue", {
	make: Effect.gen(function* () {
		const queue = yield* CancellationReviewQueueProducer

		const send = Effect.fn("CancellationReviewQueue.send")(function* (job: CancellationReviewJob) {
			yield* Effect.annotateCurrentSpan({ orgId: job.orgId, "maple.cancellation.phase": job.phase })
			yield* queue.sendBatch([{ body: encodeJob(job) }])
		})

		return { send } satisfies CancellationReviewQueueApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
