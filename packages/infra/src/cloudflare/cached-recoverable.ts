import { Deferred, Effect, Exit } from "effect"

/**
 * `Effect.cached`, except a failed run is forgotten: `cached` pins its exit,
 * failure included, for the lifetime of the isolate, and a build that failed
 * on a transient cause (a binding briefly unavailable) must be retried by a
 * later event rather than answer with the same failure until the isolate is
 * replaced.
 *
 * Single-flight: callers arriving while a run is in flight wait on that run's
 * Deferred and observe its exit, whatever it is — the failed generation is
 * evicted only after its Deferred is complete, so no waiter can find the slot
 * empty. The next caller after a failure starts a fresh run.
 */
export const cachedRecoverable = <A, E, R>(
	self: Effect.Effect<A, E, R>,
): Effect.Effect<Effect.Effect<A, E, R>> =>
	Effect.sync(() => {
		let success: Exit.Exit<A, E> | undefined
		let inFlight: Deferred.Deferred<A, E> | undefined
		return Effect.gen(function* () {
			if (success !== undefined) return yield* success
			if (inFlight !== undefined) return yield* Deferred.await(inFlight)
			const run = yield* Deferred.make<A, E>()
			inFlight = run
			return yield* self.pipe(
				Effect.onExit((exit) =>
					Effect.sync(() => {
						if (Exit.isSuccess(exit)) success = exit
						inFlight = undefined
					}).pipe(Effect.andThen(Deferred.done(run, exit))),
				),
			)
		})
	})
