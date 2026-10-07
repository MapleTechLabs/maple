import { assert, describe, it } from "@effect/vitest"
import type { MessageBatch } from "@cloudflare/workers-types"
import { OrgId } from "@maple/domain/http"
import { Effect, Layer, Schema } from "effect"
import type { CancellationReviewJob } from "@maple/backend/services/cancellation-review/CancellationReviewQueue"
import {
	CancellationReviewError,
	CancellationReviewService,
} from "@maple/backend/services/cancellation-review/CancellationReviewService"
import { processCancellationReviewBatch } from "./cancellation-review-runtime"

const job: CancellationReviewJob = {
	kind: "cancellation-review",
	orgId: Schema.decodeUnknownSync(OrgId)("org_leaving"),
	planId: "startup",
	phase: "scheduled",
	startedAt: 1_000,
	canceledAt: 2_000,
	expiresAt: 3_000,
	trial: false,
	pastDue: false,
	receivedAt: 2_500,
}

const makeBatch = (body: unknown, attempts = 1) => {
	let acknowledged = false
	let retried = false
	const message = {
		id: "message_1",
		timestamp: new Date(1_000),
		body,
		attempts,
		ack: () => {
			acknowledged = true
		},
		retry: () => {
			retried = true
		},
	}
	return {
		batch: {
			queue: "maple-cancellation-reviews-local",
			messages: [message],
			ackAll: () => undefined,
			retryAll: () => undefined,
		} as MessageBatch<unknown>,
		settled: () => ({ acknowledged, retried }),
	}
}

const process = (
	batch: MessageBatch<unknown>,
	review: (typeof CancellationReviewService)["Service"]["review"],
) =>
	processCancellationReviewBatch(batch).pipe(
		Effect.provide(Layer.succeed(CancellationReviewService, { review })),
	)

describe("cancellation review queue consumer", () => {
	it.effect("acks a review that settled", () =>
		Effect.gen(function* () {
			const { batch, settled } = makeBatch(job)
			yield* process(batch, () => Effect.succeed("posted"))
			assert.deepStrictEqual(settled(), { acknowledged: true, retried: false })
		}),
	)

	it.effect("retries a review whose upstream did not answer", () =>
		Effect.gen(function* () {
			const { batch, settled } = makeBatch(job)
			yield* process(batch, () =>
				Effect.fail(new CancellationReviewError({ message: "Slack refused", step: "post" })),
			)
			assert.deepStrictEqual(settled(), { acknowledged: false, retried: true })
		}),
	)

	it.effect("retries a review that died instead of failing the whole batch", () =>
		Effect.gen(function* () {
			const { batch, settled } = makeBatch(job)
			yield* process(batch, () => Effect.die(new Error("snapshot would not build")))
			assert.deepStrictEqual(settled(), { acknowledged: false, retried: true })
		}),
	)

	it.effect("acks a message that is not a job, which no retry could fix", () =>
		Effect.gen(function* () {
			const { batch, settled } = makeBatch({ kind: "cancellation-review", orgId: "" })
			yield* process(batch, () => Effect.die(new Error("must not be reviewed")))
			assert.deepStrictEqual(settled(), { acknowledged: true, retried: false })
		}),
	)
})
