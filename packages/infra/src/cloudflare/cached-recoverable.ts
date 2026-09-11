import { Effect, Exit } from "effect"

/**
 * `Effect.cached`, except a failed run is forgotten: `cached` pins its exit,
 * failure included, for the lifetime of the isolate, and a build that failed
 * on a transient cause (a binding briefly unavailable) must be retried by a
 * later event rather than answer with the same failure until the isolate is
 * replaced.
 *
 * Single-flight: callers arriving while a run is in flight wait on that run
 * and observe its exit, whatever it is — the failed generation is evicted in
 * the same step that settles its waiters, so no waiter can find the slot
 * empty. The next caller after a failure starts a fresh run.
 *
 * Waiters await a promise, never the run's fiber: workerd delivers a promise's
 * continuations to the request that awaited it. Resumed by a `Deferred`
 * instead, every request that reached a cold isolate while the build ran
 * continued synchronously inside the FIRST request's I/O context — its body
 * unreadable, its response never delivered, and the runtime's own 500 (no
 * CORS headers) in its place.
 */
export const cachedRecoverable = <A, E, R>(
	self: Effect.Effect<A, E, R>,
): Effect.Effect<Effect.Effect<A, E, R>> =>
	Effect.sync(() => {
		let success: Exit.Exit<A, E> | undefined
		let inFlight: Promise<Exit.Exit<A, E>> | undefined
		return Effect.gen(function* () {
			if (success !== undefined) return yield* success
			if (inFlight !== undefined) {
				const run = inFlight
				return yield* Effect.flatten(Effect.promise(() => run))
			}
			let settle!: (exit: Exit.Exit<A, E>) => void
			inFlight = new Promise((resolve) => {
				settle = resolve
			})
			return yield* self.pipe(
				Effect.onExit((exit) =>
					Effect.sync(() => {
						if (Exit.isSuccess(exit)) success = exit
						inFlight = undefined
						settle(exit)
					}),
				),
			)
		})
	})
