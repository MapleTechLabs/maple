import { describe, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"
import { expect } from "vitest"
import { closeWithin } from "./close-within.js"

describe("closeWithin", () => {
	it.effect("returns once the timeout passes, while a stuck finalizer keeps running", () =>
		Effect.gen(function* () {
			const scope = yield* Scope.make()
			let finished = false
			yield* Scope.addFinalizer(
				scope,
				Effect.uninterruptible(
					Effect.sleep("5 seconds").pipe(Effect.andThen(Effect.sync(() => (finished = true)))),
				),
			)
			const closing = yield* Effect.forkChild(closeWithin(scope, "1500 millis"))
			yield* TestClock.adjust("1500 millis")
			expect(Exit.isSuccess(yield* Fiber.await(closing))).toBe(true)
			expect(finished).toBe(false)
			yield* TestClock.adjust("3500 millis")
			expect(finished).toBe(true)
		}),
	)

	it.effect("returns as soon as a quick close is done", () =>
		Effect.gen(function* () {
			const scope = yield* Scope.make()
			let closed = false
			yield* Scope.addFinalizer(
				scope,
				Effect.sync(() => (closed = true)),
			)
			yield* closeWithin(scope, "1500 millis")
			expect(closed).toBe(true)
		}),
	)
})
