// BOUNDARY: This module owns unparsed external values and narrows them before domain use.
/**
 * The ports still filled straight off a Worker env, plus the env itself (`workerEnvLayer`).
 *
 * A service binding would be an alchemy client if alchemy could express it: `Workers.Fetch` needs
 * the target Worker inside the init, where only platform services are available. Narrowed here,
 * once, so services depend on a typed port instead of reading `WorkerEnvironment`.
 */
import { workerEnvLayer } from "@maple/infra/worker-runtime"
import { Layer, Option } from "effect"
import { AiWorkerFetcher, SandboxFetcher } from "./bindings"

/** The service-binding names the Workers declare in their props. */
export const AI_WORKER_BINDING = "AI_WORKER"
export const SANDBOX_BINDING = "SANDBOX"

const isFetcher = (value: unknown): value is Fetcher =>
	typeof value === "object" && value !== null && "fetch" in value && typeof value.fetch === "function"

const fetcherOf = (value: unknown): Option.Option<Fetcher> =>
	isFetcher(value) ? Option.some(value) : Option.none()

/** Every env-backed port, for a graph built on `env`: the Worker's init, a Durable Object's activation, a cron fire. */
export const envPorts = (env: Record<string, unknown>) =>
	Layer.mergeAll(
		workerEnvLayer(env),
		Layer.succeed(AiWorkerFetcher, fetcherOf(env[AI_WORKER_BINDING])),
		Layer.succeed(SandboxFetcher, fetcherOf(env[SANDBOX_BINDING])),
	)
