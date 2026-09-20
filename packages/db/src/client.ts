import * as PgClient from "@effect/sql-pg/PgClient"
import { EffectCache } from "drizzle-orm/cache/core/cache-effect"
import { EffectDrizzleQueryError, EffectLogger } from "drizzle-orm/effect-core"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import type { EffectPgQueryEffectHKT, EffectPgQueryResultHKT } from "drizzle-orm/effect-postgres"
import type { PgEffectDatabase } from "drizzle-orm/pg-core/effect"
import { Context, Duration, Effect, Layer, Redacted, type Scope } from "effect"
import type * as Reactivity from "effect/unstable/reactivity/Reactivity"
import { SqlError } from "effect/unstable/sql/SqlError"

/**
 * The drizzle database every Maple service codes against: Effect-native, over
 * `@effect/sql-pg` on Workers and `@effect/sql-pglite` in tests. Queries are
 * Effects (`yield* db.select()…`), transactions take an Effect callback, and
 * every failure lands in the typed channel as a `MapleDbError`.
 *
 * The driver-neutral base class rather than `effect-postgres`'s
 * `EffectPgDatabase`: the two drivers' classes differ only in `$client`, which
 * nothing above the platform layer reads, so both are one type without a cast.
 * It is also what a `tx` is, so helpers take it inside or outside a transaction.
 *
 * No `relations` are registered: Maple uses the SQL-like query builder only,
 * never `db.query.*`.
 */
export type MapleDb = PgEffectDatabase<EffectPgQueryEffectHKT, EffectPgQueryResultHKT>

/** The `tx` handed to a `db.transaction` callback. */
export type MapleTx = Parameters<Parameters<MapleDb["transaction"]>[0]>[0]

/** Either a database or a transaction — for helpers that run inside or outside one. */
export type MapleDbLike = MapleDb

/**
 * What a query or transaction fails with below the `Database` service.
 * `EffectDrizzleQueryError` wraps a statement failure (its `cause` is the
 * `SqlError`, whose `reason` is `@effect/sql`'s classification of the pg error);
 * `SqlError` on its own comes from transaction control (`BEGIN`, `COMMIT`).
 */
export type MapleDbError = EffectDrizzleQueryError | SqlError

export const isMapleDbError = (value: unknown): value is MapleDbError =>
	value instanceof EffectDrizzleQueryError || value instanceof SqlError

/**
 * The per-call statement collector. `Database.execute` provides one around
 * each call; the drizzle logger below reads it when a statement runs, so every
 * parameterized statement (including inside a transaction) lands on that
 * call's span as `db.query.text`. A reference rather than a per-call drizzle
 * wrapper: the logger is fixed when the database is built, but `logQuery`
 * returns an Effect and therefore sees the calling fiber's context.
 */
export class MapleStatementCollector extends Context.Reference<((query: string) => void) | undefined>(
	"@maple/db/MapleStatementCollector",
	{ defaultValue: () => undefined },
) {}

const mapleDrizzleLogger = Layer.succeed(EffectLogger, {
	logQuery: (query) =>
		Effect.gen(function* () {
			const collect = yield* MapleStatementCollector
			collect?.(query)
		}),
})

/**
 * Drizzle's default no-op cache plus Maple's collecting logger. Not
 * `PgDrizzle.DefaultServices`, which bundles a no-op logger that would shadow
 * this one.
 */
export const mapleDrizzleServices = Layer.merge(mapleDrizzleLogger, EffectCache.Default)

/**
 * The scope's Postgres handle: `@effect/sql-pg`'s own pooled client, scoped —
 * one per invocation on Workers, dialed lazily on the first statement.
 */
export type MaplePgClient = PgClient.PgClient

export interface MaplePgClientOptions {
	readonly maxConnections?: number
	/**
	 * Bound on one socket dial, in SECONDS. Unset, the driver's own default (5s)
	 * applies. Always pass this; see `CONNECT_TIMEOUT_SECONDS` in
	 * packages/backend/src/platform/pg-connection-scope.ts.
	 *
	 * The driver bounds connect, TLS and auth for ONE connection with it, never
	 * the wait for a free connection — a fan-out wider than the pool queues
	 * rather than failing as a connection error, which is what the old
	 * node-postgres pool needed a custom `Client` subclass to achieve.
	 *
	 * The driver option rather than an `Effect.timeout` on purpose: interrupting
	 * the fiber does not cancel the socket, so only the driver's own timer frees
	 * the connection slot.
	 */
	readonly connectTimeoutSeconds?: number
}

/**
 * Open one `@effect/sql-pg` client, for real Postgres (PlanetScale via
 * Hyperdrive in Workers, docker-compose Postgres under `alchemy dev`, direct
 * URLs in scripts).
 *
 * Scoped and lazy: the pool opens no connection until the first statement, so
 * building this costs nothing and does not touch the network, and closing the
 * scope closes whatever it opened. There is deliberately no probe; a round trip
 * on every request bought nothing but a telemetry split, which `error.type` now
 * states outright.
 *
 * Workers note: TCP sockets are tied to the request that opened them, so a
 * client may be reused freely WITHIN a request but must never outlive it. The
 * request path holds one of these per request and closes it at the boundary.
 */
export const makeMaplePgClient = (
	connectionString: string,
	options?: MaplePgClientOptions,
): Effect.Effect<MaplePgClient, SqlError, Scope.Scope | Reactivity.Reactivity> =>
	PgClient.make({
		url: Redacted.make(connectionString),
		maxConnections: options?.maxConnections ?? 5,
		...(options?.connectTimeoutSeconds === undefined
			? undefined
			: { connectTimeout: Duration.seconds(options.connectTimeoutSeconds) }),
		// Unnamed statements only, as the node-postgres pool did: a named prepared
		// statement belongs to one connection, and a pooler in front of Postgres
		// (PSBouncer, Hyperdrive) need not hand that same connection back.
		prepare: false,
	})

/**
 * Build the drizzle database over a client the caller acquires.
 *
 * `acquire` runs inside the given Scope, and the client's pool is closed when
 * that Scope closes — the invocation-scope machinery in `pg-connection-scope.ts`
 * owns both. The client layer is built with `Layer.build` rather than
 * `Effect.provide` for exactly that reason: `provide` scopes the layer to the
 * effect it wraps and would close the pool the moment the database was built.
 */
export const makeMapleEffectDb = (
	acquire: Effect.Effect<MaplePgClient, SqlError, Scope.Scope | Reactivity.Reactivity>,
): Effect.Effect<MapleDb, SqlError, Scope.Scope> =>
	Effect.gen(function* () {
		const services = yield* Layer.build(Layer.merge(mapleDrizzleServices, PgClient.layerFrom(acquire)))
		return yield* PgDrizzle.make().pipe(Effect.provideContext(services))
	})
