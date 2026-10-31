import { Effect, Fiber, Option } from "effect"
import { TestClock } from "effect/testing"
import { afterEach, describe, expect, test, vi } from "vitest"
import { clerkSessionToken } from "./clerk"

afterEach(() => {
	vi.unstubAllGlobals()
})

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect.pipe(Effect.provide(TestClock.layer())))

describe("clerkSessionToken", () => {
	test("a token refresh that never settles gives up, so the request goes out instead of hanging", () => {
		vi.stubGlobal("window", { Clerk: { session: { getToken: () => new Promise<string>(() => {}) } } })
		return run(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(clerkSessionToken)
				yield* TestClock.adjust("10 seconds")
				expect(yield* Fiber.join(fiber)).toEqual(Option.none())
			}),
		)
	})

	test("a settled token is passed through", () => {
		vi.stubGlobal("window", { Clerk: { session: { getToken: () => Promise.resolve("jwt") } } })
		return run(Effect.map(clerkSessionToken, (token) => expect(token).toEqual(Option.some("jwt"))))
	})
})
