import { Effect, Option, Scope } from "effect"
import { DrainRunOnInterrupt } from "./pg-connection-scope"

/**
 * Fork background work so it cannot outlive the invocation that owns the
 * Postgres connection.
 *
 * `Effect.forkDetach` is the wrong tool for anything that touches the database.
 * A detached fiber inherits the `PgConnectionScope` reference from the request
 * context but not the request's lifetime, so it can still be running when
 * `withPgConnectionScopeOf`'s `Effect.ensuring` closes the pool, and its next
 * `execute` is refused as `SCOPE_CLOSED` — silently, because these call sites
 * are `Effect.ignore`d.
 *
 * HTTP routes always have a request `Scope` (HttpRouter provides one), and on
 * the API worker it closes INSIDE `withPgConnectionScope`: the router that
 * creates it is the program the connection scope wraps. Closing it interrupts
 * the child, so forked work gets until the response and no longer. Non-HTTP
 * callers — crons, queue consumers, workflows — have no request Scope, and
 * there the calling fiber IS the whole job, so it is a safe parent.
 *
 * Two things keep a quick DB call that was forked right before the response
 * from being lost:
 *
 * - `startImmediately`: a merely scheduled fork would not run before the
 *   handler returned, and would wake to an interruption.
 * - `DrainRunOnInterrupt`: once the child is inside a `Database.execute`, the
 *   interruption waits for that call. node-postgres checks a client out on a
 *   later tick, so without this the statement is still queued when the
 *   interruption lands and never runs. Work before the DB call (an HTTP probe,
 *   a cache read) is still interrupted at the response.
 */
export const forkRequestScoped = <A, E, R>(work: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const scope = yield* Effect.serviceOption(Scope.Scope)
		const draining = work.pipe(Effect.provideService(DrainRunOnInterrupt, true))
		return Option.isSome(scope)
			? yield* Effect.forkIn(draining, scope.value, { startImmediately: true })
			: yield* Effect.forkChild(draining, { startImmediately: true })
	})
