import { describe, expect, it } from "@effect/vitest"
import { Duration, Effect, Fiber, Option } from "effect"
import { TestClock } from "effect/testing"
import { answeringWithin } from "./OrganizationFeatureFlagsService"

describe("answeringWithin", () => {
	const setup = () => {
		const reads = { count: 0 }
		const inTime = answeringWithin<string, number>(60_000)
		// A provider that takes five seconds to answer.
		const slow = Effect.sync(() => void reads.count++).pipe(
			Effect.andThen(Effect.sleep(Duration.seconds(5))),
			Effect.as(Option.some(1)),
		)
		const fast = Effect.sync(() => void reads.count++).pipe(Effect.as(Option.some(2)))
		return { reads, ask: (read: typeof slow) => inTime("org", Duration.seconds(2), read), slow, fast }
	}

	it.effect("answers none once the wait is over, and then without waiting or reading again", () =>
		Effect.gen(function* () {
			const { reads, ask, slow } = setup()
			const first = yield* Effect.forkChild(ask(slow))
			yield* TestClock.adjust(Duration.seconds(2))
			expect(yield* Fiber.join(first)).toEqual(Option.none())
			// Within the quiet minute: no read starts, and nothing is waited on.
			expect(yield* ask(slow)).toEqual(Option.none())
			expect(reads.count).toBe(1)
		}),
	)

	it.effect("reads again after the quiet minute, and a read in time ends it", () =>
		Effect.gen(function* () {
			const { reads, ask, slow, fast } = setup()
			const first = yield* Effect.forkChild(ask(slow))
			yield* TestClock.adjust(Duration.seconds(2))
			yield* Fiber.join(first)
			yield* TestClock.adjust(Duration.minutes(1))
			expect(yield* ask(fast)).toEqual(Option.some(2))
			expect(yield* ask(fast)).toEqual(Option.some(2))
			expect(reads.count).toBe(3)
		}),
	)
})
