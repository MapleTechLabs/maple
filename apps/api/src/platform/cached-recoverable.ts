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
 *
 * The run is pinned to the context this memo is *created* in, not the context
 * of whichever caller happens to trigger it. A memo made once per isolate is
 * triggered by some event, and that event's fiber carries services belonging
 * to it alone — an `HttpServerRequest`, its scope. Anything the run captures
 * from them outlives the event and reaches every later caller: a route graph
 * built this way pinned one request into every handler for the life of the
 * isolate. `setContext` replaces the caller's context rather than merging into
 * it, as `provideContext` would, which is what makes the caller unobservable.
 * The requirement moves to creation time, so `R` leaves the memoized effect.
 */
export const cachedRecoverable = <A, E, R>(
	self: Effect.Effect<A, E, R>,
): Effect.Effect<Effect.Effect<A, E>, never, R> =>
	Effect.map(Effect.context<R>(), (context) => {
		const run = Effect.setContext(self, context)
		let success: Exit.Exit<A, E> | undefined
		let inFlight: Deferred.Deferred<A, E> | undefined
		return Effect.gen(function* () {
			if (success !== undefined) return yield* success
			if (inFlight !== undefined) return yield* Deferred.await(inFlight)
			const generation = yield* Deferred.make<A, E>()
			inFlight = generation
			return yield* run.pipe(
				Effect.onExit((exit) =>
					Effect.sync(() => {
						if (Exit.isSuccess(exit)) success = exit
						inFlight = undefined
					}).pipe(Effect.andThen(Deferred.done(generation, exit))),
				),
			)
		})
	})
