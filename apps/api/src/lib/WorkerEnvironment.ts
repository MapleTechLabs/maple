import { WorkerEnvironment } from "@maple/effect-cf"
import { Effect, Layer } from "effect"

// effect-cf's `WorkerEnvironment` is a bare Context tag. We provide it from the
// `cloudflare:workers` runtime `env` via a dynamic import + fallback, so
// non-worker contexts (tsc, vitest) don't choke on the bare specifier. Mirrors
// the old `@maple/effect-cloudflare` `WorkerEnvironment.layer`.
const workerEnv = Effect.promise(() =>
	import("cloudflare:workers")
		.then((m) => m.env as unknown as Record<string, unknown>)
		.catch(() => ({}) as Record<string, unknown>),
)

export { WorkerEnvironment }

export const WorkerEnvironmentLive: Layer.Layer<WorkerEnvironment> = Layer.effect(
	WorkerEnvironment,
	workerEnv as Effect.Effect<never>,
)
