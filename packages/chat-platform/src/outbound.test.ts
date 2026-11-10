import { assert, describe, it } from "@effect/vitest"
import { Effect, Ref, Schema } from "effect"
import { chatConnectorId } from "./connector"
import { ChatOutboundError, type ChatOutboundOperation, withRateLimitRetry } from "./outbound"

class Limited extends Schema.TaggedError<Limited>()("test/RateLimited", {}) {}

const connectorId = chatConnectorId("test")

/** A call that is rate limited every time, counting its attempts and pauses. */
const alwaysLimited = (operation: ChatOutboundOperation) =>
	Effect.gen(function* () {
		const attempts = yield* Ref.make(0)
		const pauses = yield* Ref.make(0)
		const error = yield* withRateLimitRetry(
			Effect.andThen(
				Ref.update(attempts, (n) => n + 1),
				Effect.fail(new Limited()),
			),
			{
				operation,
				rateLimited: Limited,
				pause: () => Ref.update(pauses, (n) => n + 1),
				gaveUp: (extra) =>
					new ChatOutboundError({ message: "kept limiting", connectorId, operation, ...extra }),
			},
		).pipe(Effect.flip)
		return { error, attempts: yield* Ref.get(attempts), pauses: yield* Ref.get(pauses) }
	})

describe("withRateLimitRetry", () => {
	it.effect("waits out a few 429s on a post, then fails as rate_limited", () =>
		Effect.gen(function* () {
			const { error, attempts, pauses } = yield* alwaysLimited("post")
			assert.strictEqual(attempts, 3)
			assert.strictEqual(pauses, 2)
			assert.strictEqual(error.status, 429)
			assert.strictEqual(error.reason, "rate_limited")
		}),
	)

	it.effect("gives up on history and destinations at the first 429", () =>
		Effect.forEach(["history", "destinations"] as const, (operation) =>
			Effect.map(alwaysLimited(operation), ({ error, attempts, pauses }) => {
				assert.strictEqual(attempts, 1)
				assert.strictEqual(pauses, 0)
				assert.strictEqual(error.reason, "rate_limited")
			}),
		),
	)
})
