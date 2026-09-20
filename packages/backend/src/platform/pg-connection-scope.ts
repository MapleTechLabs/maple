import {
	type MapleDb,
	type MaplePgClient,
	type MaplePgClientOptions,
	makeMapleEffectDb,
	makeMaplePgClient,
} from "@maple/db/client"
import { trackOutboundSlot } from "@maple/cache"
import { Context, Effect, Exit, Option, Schema, Scope, Semaphore } from "effect"
import type * as Reactivity from "effect/unstable/reactivity/Reactivity"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { MapleDbConnection } from "./bindings"
import {
	type DatabaseError,
	type ExecuteError,
	executeWithSpan,
	failExecuteWithSpan,
	toDatabaseError,
} from "./DatabaseLive"

/**
 * Cloudflare's documented value for a pool behind Hyperdrive.
 *
 * `max` is a CEILING, not an allocation: the pool opens a second socket only
 * when a second statement is genuinely in flight, so a request that makes one
 * DB call still costs one connection. That is why a single value serves both
 * the request path (mostly one call per invocation) and the cron path (a tick
 * issuing thousands).
 *
 * This was 1 for one day, on the theory that Postgres should reserve at most
 * one of the Worker's six outbound slots. Reserving is not what `max` does, and
 * capping it serialized every statement in a cron tick behind one connection —
 * measured on identical queries, `SELECT actors` p50 928ms -> 5687ms and
 * `INSERT alert_rule_claims` p50 536ms -> 2989ms at flat volume. Head-of-line
 * blocking cost far more than the contention it was avoiding.
 */
export const MAX_CONNECTIONS = 5

/**
 * One dial attempt, bounded. No retry, no ladder.
 *
 * The bound exists for diagnosis as much as for latency: unset, a stalled dial
 * hangs for the whole invocation and lands with no `error.type` at all.
 *
 * 10s rather than the 2s that shipped briefly: 2s alone took production 5xx
 * from 0.06% to 5.01%, and the retry that followed existed only to compensate
 * for it. Dial latency is bimodal (p50 ~11ms, or dead), so a generous single
 * bound kills essentially only the dead ones.
 */
const CONNECT_TIMEOUT_SECONDS = 10

/**
 * A Postgres connection scoped to one invocation — a request, a cron tick, or a
 * Workflow run — created at most once and shared by every call inside it.
 *
 * This is the one primitive. `Database.execute` reaches it through
 * `PgConnectionScope`; `executeOnFreshPgClient` is it with a scope of one call;
 * the Workflow entrypoints hold one directly. There is no second implementation
 * of "open a pool, build the database over it, put a span around each call".
 */
export interface PgConnectionScopeApi {
	/** Run one logical DB call on the scope's connection, inside the standard client span. */
	readonly run: <A, E, R>(
		fn: (db: MapleDb) => Effect.Effect<A, E, R>,
	) => Effect.Effect<A, ExecuteError<E>, R>
	/** Release the connection. Safe when nothing was ever created, and safe to run twice. */
	readonly close: Effect.Effect<void>
}

/**
 * The scope in force for the current fiber, or `undefined` outside one.
 *
 * A reference rather than a service so `DatabasePgLive` can read it at call
 * time and fall back to a per-call scope where none was installed (Workflow
 * entrypoints, tests, any future entry point that forgets to wrap).
 */
export class PgConnectionScope extends Context.Reference<PgConnectionScopeApi | undefined>(
	"@maple/api/platform/PgConnectionScope",
	{ defaultValue: () => undefined },
) {}

/**
 * A call arrived after its scope was released.
 *
 * Not a database failure — nothing was dialed and no statement ran — so it
 * carries its own tag rather than being flattened into prose. `run` keeps the
 * `DatabaseError` channel that ~200 call sites are typed against, and this
 * travels as that error's `cause`, where a caller can still discriminate it and
 * a span can name it as something other than a driver fault.
 */
export class PgConnectionScopeClosedError extends Schema.TaggedError<PgConnectionScopeClosedError>()(
	"@maple/api/platform/PgConnectionScopeClosedError",
	{ message: Schema.String },
) {}

/**
 * Set by `forkRequestScoped`: a DB call that has started runs to completion
 * even when the request interrupts its fiber.
 *
 * node-postgres checks a client out on a later tick, so a statement forked
 * just before the response is still a pending waiter when the request Scope
 * interrupts the child, and it never runs. postgres.js sent it synchronously and
 * `sql.end()` drained it. Uninterruptible over the call alone restores that:
 * the request waits for a statement already on its way, not for the rest of
 * the forked work.
 */
export class DrainRunOnInterrupt extends Context.Reference<boolean>(
	"@maple/api/platform/DrainRunOnInterrupt",
	{ defaultValue: () => false },
) {}

const CLOSED_MESSAGE =
	"Postgres connection scope is already closed — this call outlived the request, cron tick or Workflow run that owned the connection"

/**
 * Test seam: how to open the scope's client. Real callers pass nothing.
 *
 * It receives the options the real factory would have been given, so a test can
 * assert the pool ceiling and the dial bound without dialing anything. Both
 * have regressed in production before.
 */
export interface PgConnectionScopeSeams {
	readonly openClient?: (
		options: MaplePgClientOptions,
	) => Effect.Effect<MaplePgClient, SqlError, Scope.Scope | Reactivity.Reactivity>
}

/**
 * Build a scope over one connection string.
 *
 * Cloudflare's documented Hyperdrive shape — one pool per invocation, created
 * lazily, ended at the boundary — reached through a `Context.Reference`
 * because `Database.execute` is called from ~200 places that cannot each be
 * handed the database.
 *
 * There is no dial step and no retry. The pool connects on the first
 * statement, so building the database cannot fail for want of a server; a
 * connection problem surfaces as that statement's error, classified by
 * `postgres-errors.ts`.
 */
export const makePgConnectionScope = (
	connectionString: string,
	extraAttributes?: Record<string, unknown>,
	seams?: PgConnectionScopeSeams,
): PgConnectionScopeApi => {
	const options: MaplePgClientOptions = {
		maxConnections: MAX_CONNECTIONS,
		connectTimeoutSeconds: CONNECT_TIMEOUT_SECONDS,
	}
	const openClient =
		seams?.openClient ?? ((opts: MaplePgClientOptions) => makeMaplePgClient(connectionString, opts))

	// Three states, not a nullable handle. Cold and Closed both used to be
	// `undefined`, which made "never dialed" and "already released" the same
	// value — so a call arriving after the boundary silently dialed a SECOND
	// socket, outside the invocation that is allowed to own one. Workers tie
	// sockets to the invocation that opened them, and the call sites that do
	// this are `Effect.ignore`d (see `fork-request-scoped.ts`), so the failure
	// never surfaced. Closed is now terminal and refuses instead of reopening.
	let state: { _tag: "Cold" } | { _tag: "Open"; scope: Scope.Closeable; db: MapleDb } | { _tag: "Closed" } =
		{
			_tag: "Cold",
		}
	// One permit orders the first open against a concurrent close, so a
	// teardown racing the first call can neither orphan a pool nor hand the
	// caller one that is being ended underneath it.
	const gate = Semaphore.makeUnsafe(1)
	const closedFailure = () => toDatabaseError(new PgConnectionScopeClosedError({ message: CLOSED_MESSAGE }))

	// The client is scoped: it registers its own close on the scope below, and a
	// teardown error there never shadows the real DB error from the call.
	const acquireClient = Effect.suspend(() => openClient(options))

	// Lazy: an invocation that never touches the database never creates one.
	const open: Effect.Effect<MapleDb, DatabaseError> = gate.withPermits(1)(
		Effect.suspend(() => {
			if (state._tag === "Open") return Effect.succeed(state.db)
			if (state._tag === "Closed") return Effect.fail(closedFailure())
			// Uninterruptible (nothing here dials) and closed on failure, so the
			// scope either becomes `Open` or is released; never orphaned while Cold.
			return Effect.uninterruptible(
				Effect.gen(function* () {
					const scope = yield* Scope.make()
					const db = yield* makeMapleEffectDb(acquireClient).pipe(
						Scope.provide(scope),
						Effect.mapError(toDatabaseError),
						Effect.onError(() => Scope.close(scope, Exit.void)),
					)
					state = { _tag: "Open", scope, db }
					return db
				}),
			)
		}),
	)

	return {
		// `suspend` so the state is read when the effect runs, not when it is built
		// — a call constructed before teardown must still be refused after it.
		run: <A, E, R>(fn: (db: MapleDb) => Effect.Effect<A, E, R>): Effect.Effect<A, ExecuteError<E>, R> =>
			Effect.suspend(() => {
				if (state._tag === "Closed") {
					return failExecuteWithSpan(closedFailure(), {
						...extraAttributes,
						"db.connect.scope_state": "closed",
						// `error.type` because `postgresErrorType` has nothing to classify
						// here: no driver was involved, so without this the span would land
						// as an unlabelled database error next to real ones.
						"error.type": "SCOPE_CLOSED",
					})
				}
				const reused = state._tag === "Open"
				// `trackOutboundSlot` scopes to the statement, not the socket: an idle
				// kept-open connection doesn't starve `cache.match()`, an in-flight
				// statement does.
				const call = trackOutboundSlot(
					executeWithSpan((hooks) => {
						hooks.record({ "db.connect.reused": reused })
						// A close can land while this call waits for a slot or the gate;
						// label that refusal the same as the synchronous one above.
						const opened = open.pipe(
							Effect.tapError(() =>
								Effect.sync(() => {
									if (state._tag === "Closed") {
										hooks.record({
											"db.connect.scope_state": "closed",
											"error.type": "SCOPE_CLOSED",
										})
									}
								}),
							),
						)
						return Effect.flatMap(opened, fn)
					}, extraAttributes),
				)
				return Effect.flatMap(DrainRunOnInterrupt, (drain) =>
					drain ? Effect.uninterruptible(call) : call,
				)
			}),

		// Closed first, then release: a call racing the teardown is refused
		// rather than handed a pool that is being ended underneath it.
		close: gate.withPermits(1)(
			Effect.suspend(() => {
				const previous = state
				state = { _tag: "Closed" }
				return previous._tag === "Open" ? Scope.close(previous.scope, Exit.void) : Effect.void
			}),
		),
	}
}

/**
 * A scope over a database someone else owns — the Workflow test seams pass a
 * PGlite-backed one. Spans carry kind, identity, timing and the statements
 * (the collector is a fiber reference, so it works over any database built
 * with Maple's logger); `close` is a no-op because the caller owns the
 * connection.
 */
export const pgConnectionScopeFrom = (
	db: MapleDb,
	extraAttributes?: Record<string, unknown>,
): PgConnectionScopeApi => ({
	run: (fn) => executeWithSpan(() => fn(db), extraAttributes),
	close: Effect.void,
})

/**
 * Run one callback against its own connection, for callers with no scope
 * installed. A scope of exactly one call — same span, same pool handling,
 * released immediately.
 *
 * A connection per call is correct but wasteful, so entry points should install
 * a scope instead where they can. Workers tie TCP sockets to the invocation
 * that opened them, so a connection may be reused freely WITHIN one but must
 * never outlive it.
 */
export const executeOnFreshPgClient = <A, E, R>(
	connectionString: string,
	fn: (db: MapleDb) => Effect.Effect<A, E, R>,
	extraAttributes?: Record<string, unknown>,
): Effect.Effect<A, ExecuteError<E>, R> =>
	Effect.suspend(() => {
		const scope = makePgConnectionScope(connectionString, extraAttributes)
		return scope.run(fn).pipe(Effect.ensuring(scope.close))
	})

/**
 * Run `program` against `scope`, releasing the connection however the program
 * settles — success, failure, or interruption. Split from
 * `withPgConnectionScope` so the release contract can be tested without a
 * connection string or a live server.
 */
export const withPgConnectionScopeOf = <A, E, R>(
	scope: PgConnectionScopeApi,
	program: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
	program.pipe(Effect.provideService(PgConnectionScope, scope), Effect.ensuring(scope.close))

/**
 * Install a connection scope for the duration of `program`.
 *
 * Stages with no application database (`MapleDbConnection` is `None`) run
 * unwrapped so `DatabasePgLive` keeps reporting the missing binding per
 * `execute` instead of failing here.
 */
export const withPgConnectionScope = <A, E, R>(
	program: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | MapleDbConnection> =>
	Effect.gen(function* () {
		const connection = yield* MapleDbConnection
		if (Option.isNone(connection)) return yield* program

		return yield* withPgConnectionScopeOf(
			makePgConnectionScope(connection.value.connectionString, connection.value.attributes),
			program,
		)
	})
