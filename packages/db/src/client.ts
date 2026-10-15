import * as PgClient from "@effect/sql-pg/PgClient"
import * as Orm from "@maple-dev/effect-orm/database"
import { CompiledQueryDecodeError, postgresDialect, QueryBuilderError } from "@maple-dev/effect-orm/postgres"
import { Context, Duration, Effect, Layer, Redacted, type Scope } from "effect"
import type * as Reactivity from "effect/reactivity/Reactivity"
import * as SqlClient from "effect/sql/SqlClient"
import { SqlError } from "effect/sql/SqlError"

/**
 * The database every Maple service codes against: effect-orm over
 * `@effect/sql-pg` on Workers and `@effect/sql-pglite` in tests. Statements are
 * Effects (`yield* db.run(PG.from(T)...)`) over the typed tables in
 * `@maple/db/tables`; `db.transaction(effect)` pins every statement in `effect`
 * to one connection through fiber context, so helpers take a `MapleDb` and run
 * inside whatever transaction their caller opened.
 */
export type MapleDb = Orm.DatabaseApi

/**
 * What a statement or transaction fails with below the `Database` service.
 * effect-orm's own errors keep the driver's `SqlError` as their `cause`;
 * `SqlError` on its own comes from opening the client.
 */
export type MapleDbError =
	| SqlError
	| Orm.DatabaseError
	| Orm.TransactionCommitFailed
	| Orm.TransactionRollbackFailed
	| Orm.TransactionOptionsRejected
	| Orm.TransactionUnsupported
	| Orm.TransactionClosed
	| QueryBuilderError
	| CompiledQueryDecodeError

export const isMapleDbError = (value: unknown): value is MapleDbError =>
	value instanceof SqlError ||
	value instanceof Orm.DatabaseError ||
	value instanceof Orm.TransactionCommitFailed ||
	value instanceof Orm.TransactionRollbackFailed ||
	value instanceof Orm.TransactionOptionsRejected ||
	value instanceof Orm.TransactionUnsupported ||
	value instanceof Orm.TransactionClosed ||
	value instanceof QueryBuilderError ||
	value instanceof CompiledQueryDecodeError

/**
 * The per-call statement collector. `Database.execute` provides one around
 * each call; `observe` below reads it when a statement runs, so every
 * statement (including inside a transaction) lands on that call's span as
 * `db.query.text`. A fiber reference rather than a per-call database: the
 * database is built once per client, but `observe` sees the calling fiber.
 */
export class MapleStatementCollector extends Context.Reference<((query: string) => void) | undefined>(
	"@maple/db/MapleStatementCollector",
	{ defaultValue: () => undefined },
) {}

/** The database over `sql`, reporting each statement to the call's collector. */
export const makeMapleDb = (sql: SqlClient.SqlClient): MapleDb =>
	Orm.fromSqlClient(sql, {
		dialect: postgresDialect,
		observe: (statement) =>
			Effect.gen(function* () {
				const collect = yield* MapleStatementCollector
				collect?.(statement.sql)
			}),
	})

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
 * Build the database over a client the caller acquires.
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
		const services = yield* Layer.build(PgClient.layerFrom(acquire))
		return makeMapleDb(Context.get(services, SqlClient.SqlClient))
	})
