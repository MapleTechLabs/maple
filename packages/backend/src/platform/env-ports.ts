// BOUNDARY: This module owns unparsed external values and narrows them before domain use.
/**
 * The ports still filled straight off a Worker env, plus the env itself (`workerEnvLayer`).
 *
 * Each would be an alchemy binding client if alchemy could express it: the cross-script
 * `ChatSession` namespace needs `jurisdiction("eu")`, which alchemy's Durable Object client does
 * not implement yet, and a service binding (`Workers.Fetch`) needs the target Worker inside the
 * init, where only platform services are available. Narrowed here, once, so services depend on a
 * typed port instead of reading `WorkerEnvironment`.
 */
import { chatSessionStub } from "@maple/domain/chat-session-stub"
import { workerEnvLayer } from "@maple/infra/worker-runtime"
import { Layer, Option } from "effect"
import { AiWorkerFetcher, ChatSessions, SandboxFetcher } from "./bindings"

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
		Layer.succeed(ChatSessions, { stub: (sessionId: string) => chatSessionStub(env, sessionId) }),
		Layer.succeed(AiWorkerFetcher, fetcherOf(env[AI_WORKER_BINDING])),
		Layer.succeed(SandboxFetcher, fetcherOf(env[SANDBOX_BINDING])),
	)
