/**
 * Bun SQLite client implementation for Effect SQL, backed by `bun:sqlite`.
 *
 * This module provides constructors and layers for using a Bun-managed SQLite database as both the
 * SQLite-specific `SqliteClient` service and the generic `SqlClient` service. It is intended for
 * file-backed or in-memory databases in Bun applications, local development tools, migrations,
 * integration tests, and embedded persistence use cases that need Effect SQL query compilation plus
 * SQLite-specific helpers such as database export and native extension loading.
 *
 * Each client owns one scoped `bun:sqlite` `Database` handle and serializes access through it, which
 * is important because Bun executes SQLite statements synchronously. WAL mode is enabled by default,
 * so set `disableWAL` when opening read-only databases or when the database file or directory cannot
 * be updated with SQLite's WAL side files. A transaction holds the serialized connection permit for
 * the transaction scope, so concurrent fibers using the same client wait until it completes, while
 * separate database handles or processes can still contend for SQLite write locks. Safe integer
 * handling follows the `SqlClient` fiber-local setting, `executeStream` is not implemented, and
 * SQLite does not support `updateValues`.
 *
 * @since 4.0.0
 */
import { Database } from "bun:sqlite"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { identity } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import * as Client from "effect/unstable/sql/SqlClient"
import type { Connection } from "effect/unstable/sql/SqlConnection"
import { classifySqliteError, SqlError } from "effect/unstable/sql/SqlError"
import * as Statement from "effect/unstable/sql/Statement"

const ATTR_DB_SYSTEM_NAME = "db.system.name"

const classifyError = (cause: unknown, message: string, operation: string) =>
  classifySqliteError(cause, { message, operation })

/**
 * Runtime type identifier used to mark Bun `SqliteClient` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export const TypeId: TypeId = "~@effect/sql-sqlite-bun/SqliteClient"

/**
 * Type-level identifier used to mark Bun `SqliteClient` values.
 *
 * @category type IDs
 * @since 4.0.0
 */
export type TypeId = "~@effect/sql-sqlite-bun/SqliteClient"

/**
 * Bun SQLite client service, extending `SqlClient` with database export and extension loading helpers. `updateValues` is not supported.
 *
 * @category models
 * @since 4.0.0
 */
export interface SqliteClient extends Client.SqlClient {
  readonly [TypeId]: TypeId
  readonly config: SqliteClientConfig
  readonly export: Effect.Effect<Uint8Array, SqlError>
  readonly loadExtension: (path: string) => Effect.Effect<void, SqlError>

  /** Not supported in sqlite */
  readonly updateValues: never
}

/**
 * Context tag used to access the Bun `SqliteClient` service.
 *
 * @category tags
 * @since 4.0.0
 */
export const SqliteClient = Context.Service<SqliteClient>("@effect/sql-sqlite-bun/Client")

/**
 * Configuration for a Bun SQLite client, including filename, open mode flags, WAL behavior, span attributes, and query/result name transforms.
 *
 * @category models
 * @since 4.0.0
 */
export interface SqliteClientConfig {
  readonly filename: string
  readonly readonly?: boolean | undefined
  readonly create?: boolean | undefined
  readonly readwrite?: boolean | undefined
  readonly disableWAL?: boolean | undefined

  readonly spanAttributes?: Record<string, unknown> | undefined

  readonly transformResultNames?: ((str: string) => string) | undefined
  readonly transformQueryNames?: ((str: string) => string) | undefined
}

interface SqliteConnection extends Connection {
  readonly export: Effect.Effect<Uint8Array, SqlError>
  readonly loadExtension: (path: string) => Effect.Effect<void, SqlError>
}

/**
 * Creates a scoped Bun SQLite client for a database file, enabling WAL by default and serializing access. Streaming queries are not implemented.
 *
 * @category constructors
 * @since 4.0.0
 */
export const make = (
  options: SqliteClientConfig
): Effect.Effect<SqliteClient, never, Scope.Scope | Reactivity.Reactivity> =>
  Effect.gen(function*() {
    const compiler = Statement.makeCompilerSqlite(options.transformQueryNames)
    const transformRows = options.transformResultNames ?
      Statement.defaultTransforms(
        options.transformResultNames
      ).array :
      undefined

    const makeConnection = Effect.gen(function*() {
      const db = new Database(options.filename, {
        readonly: options.readonly,
        readwrite: options.readwrite ?? true,
        create: options.create ?? true
      } as any)
      yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

      if (options.disableWAL !== true) {
        db.run("PRAGMA journal_mode = WAL;")
      }

      const run = (
        sql: string,
        params: ReadonlyArray<unknown> = []
      ) =>
        Effect.withFiber<Array<any>, SqlError>((fiber) => {
          const statement = db.query(sql)
          const useSafeIntegers = Context.get(fiber.context, Client.SafeIntegers)
          // @ts-ignore bun-types missing safeIntegers method, fixed in https://github.com/oven-sh/bun/pull/26627
          statement.safeIntegers(useSafeIntegers)
          try {
            return Effect.succeed((statement.all(...(params as any)) ?? []) as Array<any>)
          } catch (cause) {
            return Effect.fail(new SqlError({ reason: classifyError(cause, "Failed to execute statement", "execute") }))
          }
        })

      const runValues = (
        sql: string,
        params: ReadonlyArray<unknown> = []
      ) =>
        Effect.withFiber<Array<any>, SqlError>((fiber) => {
          const statement = db.query(sql)
          const useSafeIntegers = Context.get(fiber.context, Client.SafeIntegers)
          // @ts-ignore bun-types missing safeIntegers method, fixed in https://github.com/oven-sh/bun/pull/26627
          statement.safeIntegers(useSafeIntegers)
          try {
            return Effect.succeed((statement.values(...(params as any)) ?? []) as Array<any>)
          } catch (cause) {
            return Effect.fail(new SqlError({ reason: classifyError(cause, "Failed to execute statement", "execute") }))
          }
        })

      return identity<SqliteConnection>({
        execute(sql, params, transformRows) {
          return transformRows
            ? Effect.map(run(sql, params), transformRows)
            : run(sql, params)
        },
        executeRaw(sql, params) {
          return run(sql, params)
        },
        executeValues(sql, params) {
          return runValues(sql, params)
        },
        executeUnprepared(sql, params, transformRows) {
          return this.execute(sql, params, transformRows)
        },
        executeStream(_sql, _params) {
          return Stream.die("executeStream not implemented")
        },
        export: Effect.try({
          try: () => db.serialize(),
          catch: (cause) => new SqlError({ reason: classifyError(cause, "Failed to export database", "export") })
        }),
        loadExtension: (path) =>
          Effect.try({
            try: () => db.loadExtension(path),
            catch: (cause) =>
              new SqlError({ reason: classifyError(cause, "Failed to load extension", "loadExtension") })
          })
      })
    })

    const semaphore = yield* Semaphore.make(1)
    const connection = yield* makeConnection

    const acquirer = semaphore.withPermits(1)(Effect.succeed(connection))
    const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
      const fiber = Fiber.getCurrent()!
      const scope = Context.getUnsafe(fiber.context, Scope.Scope)
      return Effect.as(
        Effect.tap(
          restore(semaphore.take(1)),
          () => Scope.addFinalizer(scope, semaphore.release(1))
        ),
        connection
      )
    })

    return Object.assign(
      (yield* Client.make({
        acquirer,
        compiler,
        transactionAcquirer,
        spanAttributes: [
          ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
          [ATTR_DB_SYSTEM_NAME, "sqlite"]
        ],
        transformRows
      })) as SqliteClient,
      {
        [TypeId]: TypeId as TypeId,
        config: options,
        export: Effect.flatMap(acquirer, (_) => _.export),
        loadExtension: (path: string) => Effect.flatMap(acquirer, (_) => _.loadExtension(path))
      }
    )
  })

/**
 * Creates a layer from a `Config`-wrapped Bun SQLite client configuration, providing both `SqliteClient` and `SqlClient`.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerConfig = (
  config: Config.Wrap<SqliteClientConfig>
): Layer.Layer<SqliteClient | Client.SqlClient, Config.ConfigError> =>
  Layer.effectContext(
    Config.unwrap(config).pipe(
      Effect.flatMap(make),
      Effect.map((client) =>
        Context.make(SqliteClient, client).pipe(
          Context.add(Client.SqlClient, client)
        )
      )
    )
  ).pipe(Layer.provide(Reactivity.layer))

/**
 * Creates a layer from a concrete Bun SQLite client configuration, providing both `SqliteClient` and `SqlClient`.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = (
  config: SqliteClientConfig
): Layer.Layer<SqliteClient | Client.SqlClient> =>
  Layer.effectContext(
    Effect.map(make(config), (client) =>
      Context.make(SqliteClient, client).pipe(
        Context.add(Client.SqlClient, client)
      ))
  ).pipe(Layer.provide(Reactivity.layer))
