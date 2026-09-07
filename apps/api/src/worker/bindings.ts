/**
 * The api Worker's bindings, on alchemy's capabilities: the init yields one
 * typed client per resource it reaches at runtime (`bindApiClients`), which
 * attaches the native binding at plan time and reads it off the env in the
 * isolate, and the clients become the Maple-owned ports the service graph
 * depends on (`apiPorts`).
 *
 * The clients' methods are colored with alchemy's `RuntimeContext`, a
 * phantom that keeps them out of the init phase at the type level; the ports
 * discharge it with alchemy's own `RuntimeContext.phantom`, the way alchemy's
 * Durable Object helpers do, and map each client's failure onto the port's.
 */
import * as Cloudflare from "alchemy/Cloudflare"
import { RuntimeContext } from "alchemy/RuntimeContext"
import { Effect, Layer, Option } from "effect"
import {
	ApiV2RateLimit,
	AuditEventsQueueProducer,
	CliAuthRateLimit,
	type KeyValueStore,
	KeyValueStoreError,
	McpOAuthRateLimit,
	McpSessionStore,
	McpToolsRateLimit,
	type ObjectStore,
	ObjectStoreError,
	PlanetScaleWebhookQueueProducer,
	type QueueProducer,
	QueueSendError,
	RateLimitBindingError,
	type RateLimiter,
	ReplayBlobBucket,
	VcsSyncQueueProducer,
} from "../platform/bindings"
import { McpSessions } from "../resources/mcp-sessions"
import { AuditEventsQueue, PlanetScaleWebhookQueue, VcsSyncQueue } from "../resources/queues"
import { ReplayBlobs } from "../resources/replay-blobs"

/** The env key the stage partition every limiter scopes its keys under is bound as. */
export const RATE_LIMIT_PARTITION_ENV = "API_V2_RATE_LIMIT_PARTITION"

/**
 * The clients the init obtains. Each `yield*` binds its resource to the
 * Worker at plan time; in the isolate it resolves the binding from the env.
 */
export const bindApiClients = Effect.gen(function* () {
	return {
		vcsSync: yield* Cloudflare.Queues.WriteQueue(VcsSyncQueue),
		planetScaleWebhooks: yield* Cloudflare.Queues.WriteQueue(PlanetScaleWebhookQueue),
		auditEvents: yield* Cloudflare.Queues.WriteQueue(AuditEventsQueue),
		mcpSessions: yield* Cloudflare.KV.ReadWriteNamespace(McpSessions),
		// Read side of the replay payload store.
		replayBlobs: yield* Cloudflare.R2.ReadBucket(ReplayBlobs),
		apiV2RateLimit: yield* Cloudflare.RateLimit("API_V2_RATE_LIMITER", {
			namespaceId: 2026071801,
			simple: { limit: 600, period: 60 },
		}),
		cliAuthRateLimit: yield* Cloudflare.RateLimit("CLI_AUTH_RATE_LIMITER", {
			namespaceId: 2026072101,
			simple: { limit: 30, period: 60 },
		}),
		mcpOAuthRateLimit: yield* Cloudflare.RateLimit("MCP_OAUTH_RATE_LIMITER", {
			namespaceId: 2026072102,
			simple: { limit: 60, period: 60 },
		}),
		// Authenticated POST /mcp, per credential. A short window so a runaway
		// agent loop is cut off in seconds, at twice the v2 API's throughput.
		mcpToolsRateLimit: yield* Cloudflare.RateLimit("MCP_TOOLS_RATE_LIMITER", {
			namespaceId: 2026082901,
			simple: { limit: 120, period: 10 },
		}),
	}
})

export type ApiBindingClients = Effect.Success<typeof bindApiClients>

/** The binding layers `bindApiClients` needs on the init. */
export const ApiBindingLayers = Layer.mergeAll(
	Cloudflare.Queues.WriteQueueBinding,
	Cloudflare.KV.ReadWriteNamespaceBinding,
	Cloudflare.R2.ReadBucketBinding,
	Cloudflare.Workers.RateLimitBinding,
)

/** Discharge alchemy's phantom color, the way alchemy's own runtime helpers do. */
const runtime = <A, E>(effect: Effect.Effect<A, E, RuntimeContext>): Effect.Effect<A, E> =>
	// oxlint-disable-next-line effecttsgo/strict-effect-provide
	Effect.provide(effect, RuntimeContext.phantom)

const failureMessage = (cause: unknown, fallback: string): string =>
	cause instanceof Error ? cause.message : fallback

/**
 * A producer over the raw queue handle rather than alchemy's `send`: the
 * client's option type omits `delaySeconds`, which the VCS producer needs to
 * park a rate-limited continuation until the provider's budget is back.
 */
const producer = (client: Cloudflare.Queues.WriteQueueClient): QueueProducer => {
	const raw = runtime(client.raw)
	const sendError = (cause: unknown, fallback: string) =>
		new QueueSendError({ message: failureMessage(cause, fallback), cause })
	return {
		send: (body, options) =>
			raw.pipe(
				Effect.flatMap((queue) =>
					Effect.tryPromise({
						try: () => queue.send(body, options),
						catch: (cause) => sendError(cause, "queue send failed"),
					}),
				),
			),
		sendBatch: (messages) =>
			raw.pipe(
				Effect.flatMap((queue) =>
					Effect.tryPromise({
						try: () => queue.sendBatch(messages),
						catch: (cause) => sendError(cause, "queue sendBatch failed"),
					}),
				),
			),
	}
}

const limiter = (client: Cloudflare.Workers.RateLimitClient, partition: string | undefined): RateLimiter => ({
	partition,
	limit: (key) =>
		runtime(client.limit({ key })).pipe(
			Effect.mapError(
				(error) =>
					new RateLimitBindingError({
						message: "Cloudflare rate-limit binding call failed",
						cause: error.cause,
					}),
			),
		),
})

const objectStore = (client: Cloudflare.R2.ReadBucketClient): ObjectStore => ({
	getBytes: (key) =>
		runtime(client.get(key)).pipe(
			Effect.flatMap((object) =>
				object === null
					? Effect.succeed(Option.none<Uint8Array>())
					: object.bytes().pipe(Effect.map(Option.some)),
			),
			Effect.mapError((error) => new ObjectStoreError({ message: error.message, cause: error.cause })),
		),
})

const keyValueStore = (client: Cloudflare.KV.ReadWriteNamespaceClient): KeyValueStore => {
	const storeError = (error: { readonly message: string; readonly cause?: unknown }) =>
		new KeyValueStoreError({ message: error.message, cause: error.cause })
	return {
		getJson: (key) =>
			runtime(client.get<unknown>(key, "json")).pipe(
				Effect.map((value) => Option.fromNullishOr(value)),
				Effect.mapError(storeError),
			),
		put: (key, value, options) =>
			runtime(client.put(key, value, options)).pipe(Effect.mapError(storeError)),
	}
}

/**
 * The ports the service graph depends on, over the clients the init bound.
 * `env` carries the stage partition the props bind — real in the isolate,
 * empty at plan time, where nothing reads it.
 */
export const apiPorts = (clients: ApiBindingClients, env: Record<string, unknown>) => {
	const partitionValue = env[RATE_LIMIT_PARTITION_ENV]
	const partition =
		typeof partitionValue === "string" && partitionValue.trim().length > 0
			? partitionValue.trim()
			: undefined
	const mcpSessions = keyValueStore(clients.mcpSessions)
	const layer = Layer.mergeAll(
		Layer.succeed(VcsSyncQueueProducer, producer(clients.vcsSync)),
		Layer.succeed(PlanetScaleWebhookQueueProducer, producer(clients.planetScaleWebhooks)),
		Layer.succeed(AuditEventsQueueProducer, producer(clients.auditEvents)),
		Layer.succeed(ApiV2RateLimit, limiter(clients.apiV2RateLimit, partition)),
		Layer.succeed(CliAuthRateLimit, limiter(clients.cliAuthRateLimit, partition)),
		Layer.succeed(McpOAuthRateLimit, limiter(clients.mcpOAuthRateLimit, partition)),
		Layer.succeed(McpToolsRateLimit, limiter(clients.mcpToolsRateLimit, partition)),
		Layer.succeed(ReplayBlobBucket, objectStore(clients.replayBlobs)),
		Layer.succeed(McpSessionStore, mcpSessions),
	)
	return { layer, mcpSessions }
}

export type ApiPortsLayer = ReturnType<typeof apiPorts>["layer"]
