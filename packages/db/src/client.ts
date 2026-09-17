import * as PgClient from "@effect/sql-pg/PgClient"
import { EffectCache } from "drizzle-orm/cache/core/cache-effect"
import { EffectDrizzleQueryError, EffectLogger } from "drizzle-orm/effect-core"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import type { EffectPgQueryEffectHKT, EffectPgQueryResultHKT } from "drizzle-orm/effect-postgres"
import type { PgEffectDatabase } from "drizzle-orm/pg-core/effect"
import { Context, Effect, Layer, type Scope } from "effect"
import { SqlError } from "effect/unstable/sql/SqlError"
import { Client, type ClientConfig, Pool } from "pg"

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

/** A node-postgres pool — one per invocation on Workers, dialed lazily on the first statement. */
export type MaplePgPool = Pool

export interface MaplePgPoolOptions {
	readonly maxConnections?: number
	/**
	 * Bound on one socket dial, in SECONDS. Unset, a stalled dial has no bound at
	 * all. Always pass this; see `CONNECT_TIMEOUT_SECONDS` in
	 * packages/backend/src/platform/pg-connection-scope.ts.
	 *
	 * Set on each `Client`, never on the `Pool`: pg-pool applies a pool-level
	 * `connectionTimeoutMillis` to waiting for a free client as well, so a
	 * fan-out wider than the pool would fail as a connection error after that
	 * long although the server is healthy. postgres.js bounded only the dial.
	 *
	 * The driver option rather than an `Effect.timeout` on purpose: interrupting
	 * the fiber does not cancel the socket, so only the driver's own timer frees
	 * the connection slot.
	 */
	readonly connectTimeoutSeconds?: number
}

/**
 * Create one node-postgres pool, for real Postgres (PlanetScale via Hyperdrive
 * in Workers, docker-compose Postgres under `alchemy dev`, direct URLs in
 * scripts).
 *
 * Creating one costs nothing: the pool dials on the first statement, so this is
 * synchronous and does not touch the network. There is deliberately no probe
 * (`PgClient.make` runs `SELECT 1` at acquire); a round trip on every request
 * bought nothing but a telemetry split, which `error.type` now states outright.
 *
 * Workers note: TCP sockets are tied to the request that opened them, so a pool
 * may be reused freely WITHIN a request but must never outlive it. The request
 * path holds one of these per request and ends it at the boundary.
 *
 * Unnamed statements only (node-postgres prepares nothing unless a statement
 * is given a `name`), which is what a pooler-fronted, request-lived connection
 * wants: a named statement is per connection and the classic way to pin one.
 */
export const createMaplePgPool = (connectionString: string, options?: MaplePgPoolOptions): MaplePgPool => {
	const connectTimeoutSeconds = options?.connectTimeoutSeconds
	const pool = new Pool({
		connectionString,
		max: options?.maxConnections ?? 5,
		...(!(connectTimeoutSeconds === undefined)
			? { Client: dialBoundedClient(connectTimeoutSeconds * 1000) }
			: undefined),
	})
	// An idle client's socket error is emitted on the pool; unhandled, it is an
	// uncaught exception rather than the next statement's failure.
	pool.on("error", () => undefined)
	return pool
}

/** A `Client` whose own dial timer is the bound; the pool it is handed to sets none. */
const dialBoundedClient = (connectionTimeoutMillis: number): typeof Client =>
	class DialBoundedClient extends Client {
		constructor(config?: string | ClientConfig) {
			super(
				typeof config === "string"
					? { connectionString: config, connectionTimeoutMillis }
					: { ...config, connectionTimeoutMillis },
			)
		}
	}

/**
 * Build the drizzle database over a pool the caller acquires.
 *
 * `acquire` runs inside the given Scope, and the pool is ended when that Scope
 * closes — the invocation-scope machinery in `pg-connection-scope.ts` owns
 * both. The client layer is built with `Layer.build` rather than
 * `Effect.provide` for exactly that reason: `provide` scopes the layer to the
 * effect it wraps and would end the pool the moment the database was built.
 * `PgClient.fromPool` rather than `PgClient.make` because `make` probes with
 * `SELECT 1` at acquire and caps `pool.end()` at one second.
 */
export const makeMapleEffectDb = (
	acquire: Effect.Effect<MaplePgPool, SqlError, Scope.Scope>,
): Effect.Effect<MapleDb, SqlError, Scope.Scope> =>
	Effect.gen(function* () {
		const services = yield* Layer.build(
			Layer.merge(
				mapleDrizzleServices,
				PgClient.layerFrom(PgClient.fromPool({ acquire })),
			),
		)
		return yield* PgDrizzle.make().pipe(Effect.provideContext(services))
	})
