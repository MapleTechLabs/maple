import { assert, describe, it } from "@effect/vitest"
import { OrgId } from "@maple/domain/http"
import { Effect, Layer, Schema } from "effect"
import {
	CancellationReviewError,
	CancellationReviewService,
	type CancellationToReview,
} from "@maple/backend/services/cancellation-review/CancellationReviewService"
import { processCancellationReviewBatch } from "./cancellation-review-runtime"

const job: CancellationToReview = {
	orgId: Schema.decodeSync(OrgId)("org_42"),
	planId: "startup",
	phase: "scheduled",
	startedAt: 1_759_248_000_000,
	canceledAt: 1_761_840_000_000,
	expiresAt: 1_764_432_000_000,
	trial: false,
	pastDue: false,
	receivedAt: 1_761_840_001_000,
}

/** One queue message, recording which terminal call the consumer made on it. */
const message = (body: unknown, attempts = 1) => {
	const calls: Array<string> = []
	return {
		message: {
			body,
			attempts,
			ack: () => calls.push("ack"),
			retry: (options?: { readonly delaySeconds?: number }) =>
				calls.push(`retry:${options?.delaySeconds ?? "default"}`),
		},
		calls,
	}
}

const batchOf = (entry: { readonly message: unknown }) => ({ messages: [entry.message] }) as never

/** Records each review it is handed; fails, or crashes, every one when asked to. */
const reviews = (fail: false | "fail" | "die" = false) => {
	const reviewed: Array<CancellationToReview> = []
	const layer = Layer.succeed(CancellationReviewService, {
		review: (cancellation) =>
			fail === "fail"
				? Effect.fail(
						new CancellationReviewError({ message: "Autumn did not answer", step: "billing" }),
					)
				: fail === "die"
					? Effect.die("a bug")
					: Effect.sync(() => {
							reviewed.push(cancellation)
							return "posted" as const
						}),
	})
	return { reviewed, layer }
}

describe("cancellation reviews queue consumer", () => {
	it.effect("reviews the queued cancellation and acks it", () => {
		const service = reviews()
		const delivery = message(job)
		return Effect.gen(function* () {
			yield* processCancellationReviewBatch(batchOf(delivery))
			assert.deepStrictEqual(service.reviewed, [job])
			assert.deepStrictEqual(delivery.calls, ["ack"])
		}).pipe(Effect.provide(service.layer))
	})

	it.effect("retries a review that could not finish, waiting longer each attempt", () => {
		const service = reviews("fail")
		const first = message(job, 1)
		const third = message(job, 3)
		return Effect.gen(function* () {
			yield* processCancellationReviewBatch(batchOf(first))
			yield* processCancellationReviewBatch(batchOf(third))
			assert.deepStrictEqual(first.calls, ["retry:60"])
			assert.deepStrictEqual(third.calls, ["retry:240"])
		}).pipe(Effect.provide(service.layer))
	})

	it.effect("retries a review that crashed with the same backoff, not at once", () => {
		const service = reviews("die")
		const second = message(job, 2)
		return Effect.gen(function* () {
			yield* processCancellationReviewBatch(batchOf(second))
			assert.deepStrictEqual(second.calls, ["retry:120"])
		}).pipe(Effect.provide(service.layer))
	})

	it.effect("drops a review that failed on its last attempt", () => {
		const service = reviews("fail")
		const last = message(job, 6)
		return Effect.gen(function* () {
			yield* processCancellationReviewBatch(batchOf(last))
			assert.deepStrictEqual(last.calls, ["ack"])
		}).pipe(Effect.provide(service.layer))
	})

	it.effect("acks a message that is not a cancellation without reviewing it", () => {
		const service = reviews()
		const malformed = message({ ...job, orgId: 42 })
		return Effect.gen(function* () {
			yield* processCancellationReviewBatch(batchOf(malformed))
			assert.deepStrictEqual(service.reviewed, [])
			assert.deepStrictEqual(malformed.calls, ["ack"])
		}).pipe(Effect.provide(service.layer))
	})
})
