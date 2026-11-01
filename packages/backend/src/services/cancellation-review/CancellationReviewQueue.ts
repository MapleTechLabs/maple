/**
 * The cancellation review's queue: the Autumn webhook enqueues each
 * cancellation it read, and the api Worker's consumer runs the review off the
 * request (`apps/api/src/cancellation-review-runtime.ts`).
 */
import { OrgId } from "@maple/domain/http"
import { Context, Effect, Layer, Schema } from "effect"
import { CancellationReviewQueueProducer } from "@maple/backend/platform/bindings"
import type { CancellationToReview } from "./CancellationReviewService"

/** One queue message: the `CancellationToReview` the webhook read. */
export const CancellationReviewJob = Schema.Struct({
	orgId: OrgId,
	planId: Schema.String,
	phase: Schema.Literals(["scheduled", "ended"]),
	startedAt: Schema.NullOr(Schema.Finite),
	canceledAt: Schema.NullOr(Schema.Finite),
	expiresAt: Schema.NullOr(Schema.Finite),
	trial: Schema.Boolean,
	pastDue: Schema.Boolean,
	receivedAt: Schema.Finite,
})

// A field added to `CancellationToReview` and not here fails to compile, instead of being dropped.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const jobIsTheReview: Same<typeof CancellationReviewJob.Type, CancellationToReview> = true
void jobIsTheReview

const encodeJob = Schema.encodeEffect(CancellationReviewJob)

export interface CancellationReviewQueueApi {
	readonly enqueue: (
		cancellations: ReadonlyArray<CancellationToReview>,
	) => Effect.Effect<void, CancellationReviewQueueError>
}

export class CancellationReviewQueueError extends Schema.TaggedError<CancellationReviewQueueError>()(
	"@maple/backend/cancellation-review/CancellationReviewQueueError",
	{
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/** Schema-encodes cancellations onto the `cancellation-reviews` queue (`CancellationReviewQueueProducer`). */
export class CancellationReviewQueue extends Context.Service<
	CancellationReviewQueue,
	CancellationReviewQueueApi
>()("@maple/backend/cancellation-review/CancellationReviewQueue", {
	make: Effect.gen(function* () {
		const queue = yield* CancellationReviewQueueProducer

		const enqueue: CancellationReviewQueueApi["enqueue"] = Effect.fn("CancellationReviewQueue.enqueue")(
			function* (cancellations) {
				yield* Effect.annotateCurrentSpan({ "maple.cancellation.jobs": cancellations.length })
				if (cancellations.length === 0) return
				const bodies = yield* Effect.forEach(cancellations, (cancellation) =>
					encodeJob(cancellation),
				).pipe(
					Effect.mapError(
						(error) => new CancellationReviewQueueError({ message: error.message, cause: error }),
					),
				)
				yield* queue.sendBatch(bodies.map((body) => ({ body }))).pipe(
					Effect.mapError(
						(error) =>
							new CancellationReviewQueueError({
								message: error.message,
								cause: error.cause,
							}),
					),
				)
			},
		)

		return { enqueue } satisfies CancellationReviewQueueApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
