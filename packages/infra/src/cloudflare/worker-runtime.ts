/**
 * The Worker env as an Effect service. Same key as alchemy's `Cloudflare.WorkerEnvironment`, so
 * it is the same service, typed `Record<string, unknown>` so binding reads must narrow.
 */
import { reifyBoundConfigProvider } from "alchemy/Runtime"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"

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
