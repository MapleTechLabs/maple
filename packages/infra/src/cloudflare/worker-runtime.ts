/**
 * The Worker env inside an Effect graph: the `WorkerEnvironment` service and
 * the `ConfigProvider` built on the same record.
 *
 * The tag carries alchemy's exact key, so it IS alchemy's
 * `Cloudflare.WorkerEnvironment` — Effect resolves a service by that string —
 * under a stricter type: `Record<string, unknown>` rather than alchemy's
 * `Record<string, any>`, which forces every binding read to narrow. Nothing
 * here reaches for `cloudflare:workers`: the env comes from whoever holds it —
 * the Worker's init, a Durable Object's constructor, a cron fire, a test.
 */
import * as ConfigProvider from "effect/ConfigProvider"
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"

/** The Worker's `env`, under alchemy's key. */
export class WorkerEnvironment extends Context.Service<WorkerEnvironment, Record<string, unknown>>()(
	"Cloudflare.Workers.WorkerEnvironment",
) {}

/** The env as `WorkerEnvironment` plus Effect's `ConfigProvider`, so `Config.string("FOO")` resolves against the bindings. */
export const workerEnvLayer = (env: Record<string, unknown>): Layer.Layer<WorkerEnvironment> =>
	Layer.mergeAll(
		Layer.succeed(WorkerEnvironment, env),
		ConfigProvider.layer(ConfigProvider.fromUnknown(env)),
	)
