import { assert, describe, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Option, Schema } from "effect"
import { cachedRecoverable } from "./cached-recoverable"

class BuildFailure extends Schema.TaggedError<BuildFailure>()("BuildFailure", {
	attempt: Schema.Number,
}) {}

describe("cachedRecoverable", () => {
	it.effect("shares one failing build with every waiter, then rebuilds for the next caller", () =>
		Effect.gen(function* () {
			let attempts = 0
			const release = yield* Deferred.make<void>()
			const build = Effect.gen(function* () {
				const attempt = ++attempts
				yield* Deferred.await(release)
				if (attempt === 1) return yield* new BuildFailure({ attempt })
				return `built #${attempt}`
			})
			const cached = yield* cachedRecoverable(build)

			// Two cold callers arrive before the first build settles.
			const first = yield* Effect.forkChild(Effect.exit(cached))
			const second = yield* Effect.forkChild(Effect.exit(cached))
			yield* Effect.yieldNow
			yield* Effect.yieldNow
			assert.strictEqual(attempts, 1)
			yield* Deferred.succeed(release, undefined)

			const exits = yield* Effect.all([Fiber.join(first), Fiber.join(second)])
			for (const exit of exits) {
				const failure = Exit.isFailure(exit)
					? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
					: undefined
				assert.deepStrictEqual(failure, new BuildFailure({ attempt: 1 }))
			}

			// The failed generation is gone: the next caller builds again and
			// every caller after it shares the success.
			assert.strictEqual(yield* cached, "built #2")
			assert.strictEqual(yield* cached, "built #2")
			assert.strictEqual(attempts, 2)
		}),
	)
})
