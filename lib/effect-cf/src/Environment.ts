import { Config, ConfigProvider, Context, Effect } from "effect";

/** Cloudflare worker environment object (`env`). */
export type WorkerEnv = Cloudflare.Env;

/**
 * Context service for reading worker bindings from the current `env` object.
 */
export class WorkerEnvironment extends Context.Service<WorkerEnvironment, WorkerEnv>()(
  "effect-cf/WorkerEnvironment",
) {}

type ScalarConfigValue = string | number | boolean;

type ScalarConfigKey = Extract<
  {
    readonly [Key in keyof Cloudflare.Env]-?: NonNullable<
      Cloudflare.Env[Key]
    > extends ScalarConfigValue
      ? Key
      : never;
  }[keyof Cloudflare.Env],
  string
>;

/**
 * Effect `Config` helpers for scalar Cloudflare vars and secrets declared on
 * `Cloudflare.Env` / generated `worker-configuration.d.ts`.
 *
 * Users still author their app config explicitly with Effect `Config`:
 *
 * ```ts
 * import { Config, Effect } from "effect";
 * import { WorkerConfig } from "effect-cf";
 *
 * const AppConfig = Config.all({
 *   databaseUrl: WorkerConfig.redacted("DATABASE_URL"),
 *   port: WorkerConfig.integer("PORT").pipe(Config.withDefault(8787)),
 * });
 *
 * const program = Effect.gen(function* () {
 *   const config = yield* AppConfig;
 *   // ...
 * }).pipe(Effect.provide(WorkerConfig.layer));
 * ```
 *
 * Keys are constrained to scalar `Cloudflare.Env` properties (`string`,
 * `number`, or `boolean`, including optional scalar properties). Binding
 * objects such as `KVNamespace`, `DurableObjectNamespace`, and service
 * bindings are intentionally excluded; keep using the package binding helpers
 * for those live resources.
 */
export namespace WorkerConfig {
  /** Scalar env value types supported by the typed config key helpers. */
  export type Scalar = ScalarConfigValue;

  /** Scalar keys available on the current consumer's `Cloudflare.Env`. */
  export type Key = ScalarConfigKey;

  /** Read a scalar Cloudflare var or secret as a string. */
  export const string = <const Name extends Key>(name: Name) => Config.string(name);

  /** Read a scalar Cloudflare secret as a redacted string. */
  export const redacted = <const Name extends Key>(name: Name) => Config.redacted(name);

  /** Read a scalar Cloudflare var or secret as a number. */
  export const number = <const Name extends Key>(name: Name) => Config.number(name);

  /** Read a scalar Cloudflare var or secret as an integer. */
  export const integer = <const Name extends Key>(name: Name) => Config.int(name);

  /** Read a scalar Cloudflare var or secret as a boolean. */
  export const boolean = <const Name extends Key>(name: Name) => Config.boolean(name);

  /** Build a `ConfigProvider` from a Cloudflare worker `env` object. */
  export const providerFromEnv = (env: WorkerEnv) => ConfigProvider.fromUnknown(env);

  /**
   * Build a `ConfigProvider` from the current `WorkerEnvironment` with a custom
   * conversion function.
   */
  export const providerWith = (makeProvider: (env: WorkerEnv) => ConfigProvider.ConfigProvider) =>
    Effect.map(WorkerEnvironment, makeProvider);

  /** Build a `ConfigProvider` from the current `WorkerEnvironment`. */
  export const provider = providerWith(providerFromEnv);

  /**
   * Replace the active Effect `ConfigProvider` with one backed by the current
   * Cloudflare worker `env` object.
   */
  export const providerLayer = ConfigProvider.layer(provider);

  /** Alias for `providerLayer` for concise use in worker layers. */
  export const layer = providerLayer;

  /** Build a `ConfigProvider` layer with a custom `env` conversion function. */
  export const layerWith = (makeProvider: (env: WorkerEnv) => ConfigProvider.ConfigProvider) =>
    ConfigProvider.layer(providerWith(makeProvider));
}
