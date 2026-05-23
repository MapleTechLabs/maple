/**
 * Bun Redis integration backed by Bun's built-in `RedisClient`.
 *
 * This module provides scoped layers that create a Bun `RedisClient` and expose
 * both the low-level `Redis` service used by Effect persistence modules and the
 * `BunRedis` service for direct access to the underlying client. Use it in Bun
 * applications that need Redis-backed persistence, persisted queues,
 * distributed rate limiting, custom Redis commands, or Bun Redis features such
 * as pub/sub through the raw client.
 *
 * The client is acquired when the layer is built and closed with `close` when
 * the layer scope ends, so install the layer at the lifetime you want for the
 * connection and pass a Redis URL, Bun `RedisOptions`, or `layerConfig` for
 * connection settings. The portable `Redis` service sends ordinary commands
 * through `RedisClient.send`; pub/sub is available through `BunRedis.client`
 * or `BunRedis.use` and should normally use a separately scoped client so a
 * subscription does not interfere with command traffic used by persistence or
 * rate limiter stores.
 *
 * Persistence and rate limiter stores build keys and Lua scripts on top of this
 * service. Choose stable prefixes and store ids to avoid collisions, account
 * for persisted values that may fail to decode after schema changes, and avoid
 * unbounded high-cardinality rate-limit keys unless you have a cleanup or
 * bounding strategy.
 *
 * @since 4.0.0
 */
import { RedisClient, type RedisOptions } from "bun"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Fn from "effect/Function"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as Redis from "effect/unstable/persistence/Redis"

/**
 * Service tag for Bun Redis integration, exposing the raw `RedisClient` and a `use` helper that maps client promise failures to `RedisError`.
 *
 * @category services
 * @since 4.0.0
 */
export class BunRedis extends Context.Service<BunRedis, {
  readonly client: RedisClient
  readonly use: <A>(f: (client: RedisClient) => Promise<A>) => Effect.Effect<A, Redis.RedisError>
}>()("@effect/platform-bun/BunRedis") {}

const make = Effect.fnUntraced(function*(
  options?: {
    readonly url?: string
  } & RedisOptions
) {
  const scope = yield* Effect.scope
  yield* Scope.addFinalizer(scope, Effect.sync(() => client.close()))
  const client = new RedisClient(options?.url, options)

  const use = <A>(f: (client: RedisClient) => Promise<A>) =>
    Effect.tryPromise({
      try: () => f(client),
      catch: (cause) => new Redis.RedisError({ cause })
    })

  const redis = yield* Redis.make({
    send: <A = unknown>(command: string, ...args: ReadonlyArray<string>) =>
      Effect.tryPromise({
        try: () => client.send(command, args as Array<string>) as Promise<A>,
        catch: (cause) => new Redis.RedisError({ cause })
      })
  })

  const bunRedis = Fn.identity<BunRedis["Service"]>({
    client,
    use
  })

  return Context.make(BunRedis, bunRedis).pipe(
    Context.add(Redis.Redis, redis)
  )
})

/**
 * Creates scoped Bun Redis layers for `Redis.Redis` and `BunRedis`, closing the underlying client when the scope finalizes.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = (
  options?: ({ readonly url?: string } & RedisOptions) | undefined
): Layer.Layer<Redis.Redis | BunRedis> => Layer.effectContext(make(options))

/**
 * Creates scoped Bun Redis layers from configurable Redis options, closing the underlying client when the scope finalizes.
 *
 * @category layers
 * @since 4.0.0
 */
export const layerConfig = (
  options: Config.Wrap<{ readonly url?: string } & RedisOptions>
): Layer.Layer<Redis.Redis | BunRedis, Config.ConfigError> =>
  Layer.effectContext(
    Config.unwrap(options).pipe(
      Effect.flatMap(make)
    )
  )
