/**
 * The api Worker's bindings, on alchemy's capabilities: the init yields one
 * typed client per resource it reaches at runtime (`bindApiClients`), which
 * attaches the native binding at plan time and reads it off the env in the
 * isolate, and the clients become the Maple-owned ports the service graph
 * depends on (`apiPorts`).
 *
 */
import { MapleDb } from "@maple/infra/cloudflare"
import * as Cloudflare from "alchemy/Cloudflare"
import { RuntimeContext } from "alchemy/RuntimeContext"
import { Effect, Layer, Option } from "effect"
import {
	ApiV2RateLimit,
	AuditEventsQueueProducer,
	CliAuthRateLimit,
	EmailSender,
	McpOAuthRateLimit,
	type ObjectStore,
	ObjectStoreError,
	PlanetScaleWebhookQueueProducer,
	type QueueProducer,
	QueueSendError,
	RateLimitBindingError,
	type RateLimiter,
	ReplayBlobBucket,
	SchemaApplyWorkflow,
	VcsSyncQueueProducer,
	WorkflowStartError,
	type WorkflowStarter,
} from "@maple/backend/platform/bindings"
import { bindEmailSender } from "@maple/backend/platform/email-sender"
import { envPorts } from "@maple/backend/platform/env-ports"
import { mapleDbConnectionLayer } from "@maple/backend/platform/pg-connection-source"
import {
	API_V2_RATE_LIMIT_PERIOD_SECONDS,
	API_V2_RATE_LIMIT_REQUESTS,
} from "@maple/backend/services/auth/ApiV2RateLimiter"
import { AuditEventsQueue, PlanetScaleWebhookQueue, VcsSyncQueue } from "../resources/queues"
import { ReplayBlobs } from "../resources/replay-blobs"

/**
 * The clients the init obtains. Each `yield*` binds its resource to the
 * Worker at plan time; in the isolate it resolves the binding from the env.
 */
export const bindApiClients = Effect.gen(function* () {
	// `MAPLE_DB`, in the stage's flavor; read back off the env by the port below.
	yield* MapleDb("api")
	return {
		vcsSync: yield* Cloudflare.Queues.WriteQueue(VcsSyncQueue),
		planetScaleWebhooks: yield* Cloudflare.Queues.WriteQueue(PlanetScaleWebhookQueue),
		auditEvents: yield* Cloudflare.Queues.WriteQueue(AuditEventsQueue),
		// Read side of the replay payload store.
		replayBlobs: yield* Cloudflare.R2.ReadBucket(ReplayBlobs),
		apiV2RateLimit: yield* Cloudflare.RateLimit("API_V2_RATE_LIMITER", {
			namespaceId: 2026071801,
			simple: { limit: API_V2_RATE_LIMIT_REQUESTS, period: API_V2_RATE_LIMIT_PERIOD_SECONDS },
		}),
		cliAuthRateLimit: yield* Cloudflare.RateLimit("CLI_AUTH_RATE_LIMITER", {
			namespaceId: 2026072101,
			simple: { limit: 30, period: 60 },
		}),
		mcpOAuthRateLimit: yield* Cloudflare.RateLimit("MCP_OAUTH_RATE_LIMITER", {
			namespaceId: 2026072102,
			simple: { limit: 60, period: 60 },
		}),
		// `send_email`, prd only.
		email: yield* bindEmailSender,
	}
})

type ApiBindingClients = Effect.Success<typeof bindApiClients>

/** The binding layers `bindApiClients` needs on the init. */
export const ApiBindingLayers = Layer.mergeAll(
	Cloudflare.Hyperdrive.ConnectBinding,
	Cloudflare.Queues.WriteQueueBinding,
	Cloudflare.R2.ReadBucketBinding,
	Cloudflare.Workers.RateLimitBinding,
	Cloudflare.Email.SendBinding,
)

/** Discharge alchemy's phantom color, the way alchemy's own runtime helpers do. */
const runtime = <A, E>(effect: Effect.Effect<A, E, RuntimeContext>): Effect.Effect<A, E> =>
	// oxlint-disable-next-line effecttsgo/strict-effect-provide
	Effect.provide(effect, RuntimeContext.phantom)

/**
 * A producer over the raw queue handle rather than alchemy's `send`: the
 * client's option type omits `delaySeconds`, which the VCS producer needs to
 * park a rate-limited continuation until the provider's budget is back.
 */
const producer = (client: Cloudflare.Queues.WriteQueueClient): QueueProducer => ({
	sendBatch: (messages) =>
		runtime(client.raw).pipe(
			Effect.flatMap((queue) =>
				Effect.tryPromise({
					try: () => queue.sendBatch(messages),
					catch: (cause) =>
						new QueueSendError({
							message: cause instanceof Error ? cause.message : "queue sendBatch failed",
							cause,
						}),
				}),
			),
		),
})

const limiter = (client: Cloudflare.Workers.RateLimitClient): RateLimiter => ({
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

/**
 * Alchemy's `create` dies when the binding rejects; recovered here into the
 * port's typed channel, so the caller can release the run it claimed.
 */
const workflowStarter = <Params>(handle: Cloudflare.WorkflowHandle<Params>): WorkflowStarter<Params> => ({
	create: (params) =>
		handle.create({ params }).pipe(
			Effect.asVoid,
			Effect.catchDefect((cause) =>
				Effect.fail(
					new WorkflowStartError({
						message: cause instanceof Error ? cause.message : "workflow create failed",
						cause,
					}),
				),
			),
		),
})

/**
 * The ports the service graph depends on, over the clients the init bound,
 * plus the env-backed ports (`envPorts`: the env itself as `WorkerEnvironment`,
 * the `ConfigProvider`, chat sessions, the ai service binding) — the one place
 * a graph in this Worker gets its env from. `env` carries the `MAPLE_DB`
 * binding — real in the isolate, empty at plan time, where nothing reads it.
 */
export const apiPorts = (
	clients: ApiBindingClients,
	schemaApply: Cloudflare.WorkflowHandle<{ readonly orgId: string }>,
	env: Record<string, unknown>,
) =>
	Layer.mergeAll(
		Layer.succeed(VcsSyncQueueProducer, producer(clients.vcsSync)),
		Layer.succeed(PlanetScaleWebhookQueueProducer, producer(clients.planetScaleWebhooks)),
		Layer.succeed(AuditEventsQueueProducer, producer(clients.auditEvents)),
		Layer.succeed(ApiV2RateLimit, limiter(clients.apiV2RateLimit)),
		Layer.succeed(CliAuthRateLimit, limiter(clients.cliAuthRateLimit)),
		Layer.succeed(McpOAuthRateLimit, limiter(clients.mcpOAuthRateLimit)),
		Layer.succeed(ReplayBlobBucket, objectStore(clients.replayBlobs)),
		Layer.succeed(EmailSender, clients.email),
		Layer.succeed(SchemaApplyWorkflow, workflowStarter(schemaApply)),
		mapleDbConnectionLayer(env),
		envPorts(env),
	)

export type ApiPortsLayer = ReturnType<typeof apiPorts>
