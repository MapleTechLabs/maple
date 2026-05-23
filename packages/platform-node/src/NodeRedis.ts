/**
 * Node.js Redis integration backed by `ioredis`.
 *
 * This module provides scoped layers that create an `ioredis` client and expose
 * both the low-level `Redis` service used by Effect persistence modules and the
 * `NodeRedis` service for direct access to the underlying client. It is useful
 * for Node applications that want Redis-backed persistence, persisted queues,
 * distributed rate limiting, or custom Redis commands alongside the Effect
 * services that build on Redis.
 *
 * The client is acquired when the layer is built and closed with `quit` when
 * the layer scope ends, so install the layer at the lifetime you want for the
 * connection and pass `ioredis` options, or `layerConfig`, for connection,
 * TLS, database, retry, and reconnect settings. Persistence and rate limiter
 * stores build their own keys and Lua scripts on top of this service; choose
 * stable prefixes and store ids to avoid collisions, account for persisted
 * values that may fail to decode after schema changes, and avoid unbounded
 * high-cardinality rate-limit keys unless you have a cleanup or bounding
 * strategy.
 *
 * @since 4.0.0
 */
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Fn from "effect/Function"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as Redis from "effect/unstable/persistence/Redis"
import * as IoRedis from "ioredis"

/**
 * Service tag for the Node Redis integration, exposing the underlying
 * `ioredis` client and a `use` helper that maps client failures to
 * `RedisError`.
 *
 * @category services
 * @since 4.0.0
 */
export class NodeRedis extends Context.Service<NodeRedis, {
  readonly client: IoRedis.Redis
  readonly use: <A>(f: (client: IoRedis.Redis) => Promise<A>) => Effect.Effect<A, Redis.RedisError>
}>()("@effect/platform-node/NodeRedis") {}

const make = Effect.fnUntraced(function*(
  options?: IoRedis.RedisOptions
) {
  const scope = yield* Effect.scope
  yield* Scope.addFinalizer(scope, Effect.promise(() => client.quit()))
  const client = new IoRedis.Redis(options ?? {})

  const use = <A>(f: (client: IoRedis.Redis) => Promise<A>) =>
    Effect.tryPromise({
      try: () => f(client),
      catch: (cause) => new Redis.RedisError({ cause })
    })

  const redis = yield* Redis.make({
    send: <A = unknown>(command: string, ...args: ReadonlyArray<string>) =>
      Effect.tryPromise({
        try: () => client.call(command, ...args) as Promise<A>,
        catch: (cause) => new Redis.RedisError({ cause })
      })
  })

  const nodeRedis = Fn.identity<NodeRedis["Service"]>({
    client,
    use
  })

  return Context.make(NodeRedis, nodeRedis).pipe(
    Context.add(Redis.Redis, redis)
  )
})

/**
 * Provides `Redis` and `NodeRedis` services backed by an `ioredis` client
 * created with the supplied options and closed when the layer scope ends.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = (
  options?: IoRedis.RedisOptions | undefined
): Layer.Layer<Redis.Redis | NodeRedis> => Layer.effectContext(make(options))

/**
 * Provides `Redis` and `NodeRedis` services from `Config`-backed ioredis
 * options, closing the client when the layer scope ends.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerConfig: (
  options: Config.Wrap<IoRedis.RedisOptions>
) => Layer.Layer<Redis.Redis | NodeRedis, Config.ConfigError> = (
  options: Config.Wrap<IoRedis.RedisOptions>
): Layer.Layer<Redis.Redis | NodeRedis, Config.ConfigError> =>
  Layer.effectContext(
    Config.unwrap(options).pipe(
      Effect.flatMap(make)
    )
  )
