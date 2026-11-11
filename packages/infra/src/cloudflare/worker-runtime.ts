/**
 * The Worker env as an Effect service. Same key as alchemy's `Cloudflare.WorkerEnvironment`, so
 * it is the same service, typed `Record<string, unknown>` so binding reads must narrow.
 */
import { reifyBoundConfigProvider } from "alchemy/Runtime"
import { RuntimeContext } from "alchemy/RuntimeContext"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Option from "effect/Option"
import * as Schema from "effect/Schema"

/** The Worker's `env`, under alchemy's key. */
export class WorkerEnvironment extends Context.Service<WorkerEnvironment, Record<string, unknown>>()(
	"Cloudflare.Workers.WorkerEnvironment",
) {}

/**
 * The env as `WorkerEnvironment` plus Effect's `ConfigProvider`, so `Config.String("FOO")` resolves against the bindings.
 * Alchemy's reifier unwraps the Redacted markers its deploy-time `Config` auto-binding leaves on the env.
 */
export const workerEnvLayer = (env: Record<string, unknown>): Layer.Layer<WorkerEnvironment> =>
	Layer.mergeAll(
		Layer.succeed(WorkerEnvironment, env),
		ConfigProvider.layer(reifyBoundConfigProvider(ConfigProvider.fromUnknown(env), env)),
	)

/** Discharge alchemy's phantom color, the way alchemy's own runtime helpers do. */
export const dischargeRuntimeContext = <A, E>(
	effect: Effect.Effect<A, E, RuntimeContext>,
): Effect.Effect<A, E> =>
	// oxlint-disable-next-line effecttsgo/strict-effect-provide -- a phantom tag with no service behind it; nothing to compose at a root
	Effect.provide(effect, RuntimeContext.phantom)

/** The application database binding's name, also the managed Connection's logical id. */
export const MAPLE_DB_BINDING = "MAPLE_DB"

/** What a Worker reads off the `MAPLE_DB` binding: the runtime `Hyperdrive` object's connection facts. */
const MapleDbBinding = Schema.Struct({
	connectionString: Schema.String.check(Schema.isNonEmpty()),
	host: Schema.String,
	port: Schema.Number,
	database: Schema.String,
})
export type MapleDbBinding = typeof MapleDbBinding.Type

/** The `MAPLE_DB` binding off a Worker env, or `None` when absent or not a Hyperdrive object. */
export const readMapleDbBinding = (env: Record<string, unknown>): Option.Option<MapleDbBinding> =>
	Schema.decodeUnknownOption(MapleDbBinding)(env[MAPLE_DB_BINDING])
