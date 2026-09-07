import { ConfigProvider, type Layer } from "effect"

/**
 * Convenience: wrap `env` as an Effect `ConfigProvider` layer. Useful when
 * composing telemetry / config-reading layers inside `makeLayer`.
 */
export const layerFromEnv = (env: Record<string, unknown>): Layer.Layer<never, never, never> =>
	ConfigProvider.layer(ConfigProvider.fromUnknown(env))

// The worker env + Config surface lives next door, re-exported here so worker
// code has a single specifier (`@maple/infra/worker-runtime`) for "things I
// need to bootstrap an Effect runtime inside a Cloudflare Worker".
export {
	layerFromEnvRecord,
	WorkerConfigProvider,
	WorkerConfigProviderLayer,
	WorkerEnvironment,
	workerEnvironmentLayer,
} from "./worker-env.ts"
