/**
 * The api Worker's bindings, on alchemy's capabilities: the init yields one
 * typed client per resource it reaches at runtime (`bindApiClients`), which
 * attaches the native binding at plan time and reads it off the env in the
 * isolate, and the clients become the Maple-owned ports the service graph
 * depends on (`apiPorts`).
 *
 */
import { StatusPageStore } from "@maple/backend/services/status-pages/StatusPageStore"
import { StatusSnapshotsBucket, StatusSnapshotsKv } from "@maple/infra/cloudflare"
import { AuditIntakeQueue, MapleDb, ReplayBlobs, SourceMapsBucket } from "@maple/infra/cloudflare"
import * as Cloudflare from "@alchemy.run/cloudflare"
import { dischargeRuntimeContext } from "@maple/infra/worker-runtime"
import { Array as Arr, Effect, Layer, Option } from "effect"
import {
	ApiV2RateLimit,
	AuditEventsQueueProducer,
	AwsEventsRateLimit,
	CancellationReviewQueueProducer,
	CliAuthRateLimit,
	DataSourceDevelopmentCallLimit,
	DataSourceProductionCallLimit,
	DataSourceSqlQueryLimit,
	EmailSender,
	McpOAuthRateLimit,
	type ObjectStore,
	ObjectStoreError,
	PlanetScaleWebhookQueueProducer,
	RateLimitBindingError,
	type RateLimiter,
	ReplayBlobBucket,
	SchemaApplyWorkflow,
	SelfHostedLoginRateLimit,
	ShareLinkRateLimit,
	VcsBackfillQueueProducer,
	VcsSyncQueueProducer,
	WorkflowStartError,
	type WorkflowStarter,
	sourceMapBucketLayer,
	type WritableObjectStore,
} from "@maple/backend/platform/bindings"
import { bindChatSessions, layerChatSessions } from "@maple/backend/platform/chat-sessions"
import { bindEmailSender } from "@maple/backend/platform/email-sender"
import { envPorts } from "@maple/backend/platform/env-ports"
import { queueProducer } from "@maple/backend/platform/queue-producer"
import { layerMapleDbConnection } from "@maple/backend/platform/pg-connection-source"
import {
	DATA_SOURCE_CALL_LIMITS,
	DATA_SOURCE_SQL_QUERY_LIMIT,
} from "@maple/backend/services/data-sources/DataSourceCallBudgetLive"
import {
	API_V2_RATE_LIMIT_PERIOD_SECONDS,
	API_V2_RATE_LIMIT_REQUESTS,
} from "@maple/backend/services/auth/ApiV2RateLimiter"
import {
	AWS_EVENTS_RATE_LIMIT_PERIOD_SECONDS,
	AWS_EVENTS_RATE_LIMIT_REQUESTS,
} from "@maple/backend/services/cloud-security/AwsEventsRateLimiter"
import {
	SHARE_LINK_RATE_LIMIT_PERIOD_SECONDS,
	SHARE_LINK_RATE_LIMIT_REQUESTS,
} from "@maple/backend/services/auth/ShareRateLimiter"
import {
	SELF_HOSTED_LOGIN_RATE_LIMIT_ATTEMPTS,
	SELF_HOSTED_LOGIN_RATE_LIMIT_PERIOD_SECONDS,
} from "@maple/backend/services/auth/SelfHostedLoginRateLimiter"
import {
	CancellationReviewsQueue,
	PlanetScaleWebhookQueue,
	VcsBackfillQueue,
	VcsSyncQueue,
} from "../resources/queues"

/**
 * The clients the init obtains. Each `yield*` binds its resource to the
 * Worker at plan time; in the isolate it resolves the binding from the env.
 */
export const bindApiClients = Effect.gen(function* () {
	// `MAPLE_DB`, in the stage's flavor; read back off the env by the port below.
	yield* MapleDb
	return {
		vcsSync: yield* Cloudflare.Queues.WriteQueue(VcsSyncQueue),
		vcsBackfill: yield* Cloudflare.Queues.WriteQueue(VcsBackfillQueue),
		planetScaleWebhooks: yield* Cloudflare.Queues.WriteQueue(PlanetScaleWebhookQueue),
		auditEvents: yield* Cloudflare.Queues.WriteQueue(AuditIntakeQueue),
		cancellationReviews: yield* Cloudflare.Queues.WriteQueue(CancellationReviewsQueue),
		// Read side of the replay payload store.
		replayBlobs: yield* Cloudflare.R2.ReadBucket(ReplayBlobs),
		// Published status pages: the publish endpoint writes snapshots, page deletes clear them.
		statusKv: yield* Cloudflare.KV.ReadWriteNamespace(StatusSnapshotsKv),
		statusBucket: yield* Cloudflare.R2.ReadWriteBucket(StatusSnapshotsBucket),
		// Uploaded source maps: the v2 upload writes them, symbolication reads them.
		sourceMaps: yield* Cloudflare.R2.ReadWriteBucket(SourceMapsBucket),
		apiV2RateLimit: yield* Cloudflare.RateLimit("API_V2_RATE_LIMITER", {
			namespaceId: 2026071801,
			simple: { limit: API_V2_RATE_LIMIT_REQUESTS, period: API_V2_RATE_LIMIT_PERIOD_SECONDS },
		}),
		shareLinkRateLimit: yield* Cloudflare.RateLimit("SHARE_LINK_RATE_LIMITER", {
			namespaceId: 2026110401,
			simple: { limit: SHARE_LINK_RATE_LIMIT_REQUESTS, period: SHARE_LINK_RATE_LIMIT_PERIOD_SECONDS },
		}),
		cliAuthRateLimit: yield* Cloudflare.RateLimit("CLI_AUTH_RATE_LIMITER", {
			namespaceId: 2026072101,
			simple: { limit: 30, period: 60 },
		}),
		selfHostedLoginRateLimit: yield* Cloudflare.RateLimit("SELF_HOSTED_LOGIN_RATE_LIMITER", {
			namespaceId: 2026111811,
			simple: {
				limit: SELF_HOSTED_LOGIN_RATE_LIMIT_ATTEMPTS,
				period: SELF_HOSTED_LOGIN_RATE_LIMIT_PERIOD_SECONDS,
			},
		}),
		mcpOAuthRateLimit: yield* Cloudflare.RateLimit("MCP_OAUTH_RATE_LIMITER", {
			namespaceId: 2026072102,
			simple: { limit: 60, period: 60 },
		}),
		// One AWS connection's finding events, keyed by connection id.
		awsEventsRateLimit: yield* Cloudflare.RateLimit("AWS_EVENTS_RATE_LIMITER", {
			namespaceId: 2026111701,
			simple: { limit: AWS_EVENTS_RATE_LIMIT_REQUESTS, period: AWS_EVENTS_RATE_LIMIT_PERIOD_SECONDS },
		}),
		// Maple's share of each connected Clerk instance's API limit, keyed by data source id.
		// Shared by every worker that queries sources, so the namespace ids must match across them.
		dataSourceProductionCallLimit: yield* Cloudflare.RateLimit("DATA_SOURCE_PRODUCTION_CALL_LIMITER", {
			namespaceId: 2026110801,
			simple: DATA_SOURCE_CALL_LIMITS.production,
		}),
		dataSourceDevelopmentCallLimit: yield* Cloudflare.RateLimit("DATA_SOURCE_DEVELOPMENT_CALL_LIMITER", {
			namespaceId: 2026110802,
			simple: DATA_SOURCE_CALL_LIMITS.development,
		}),
		// Queries Maple sends one connected ClickHouse, keyed by data source id. Shared the same way.
		dataSourceSqlQueryLimit: yield* Cloudflare.RateLimit("DATA_SOURCE_SQL_QUERY_LIMITER", {
			namespaceId: 2026111801,
			simple: DATA_SOURCE_SQL_QUERY_LIMIT,
		}),
		// `send_email`, prd only.
		email: yield* bindEmailSender,
		// maple-ai's chat Durable Object, cross-script.
		chatSessions: yield* bindChatSessions,
	}
})

type ApiBindingClients = Effect.Success<typeof bindApiClients>

/** The binding layers `bindApiClients` needs on the init. */
export const ApiBindingsLive = Layer.mergeAll(
	Cloudflare.Hyperdrive.ConnectBinding,
	Cloudflare.Queues.WriteQueueBinding,
	Cloudflare.R2.ReadBucketBinding,
	Cloudflare.KV.ReadWriteNamespaceBinding,
	Cloudflare.R2.ReadWriteBucketBinding,
	Cloudflare.Workers.RateLimitBinding,
	Cloudflare.Email.SendBinding,
)

const limiter = (client: Cloudflare.Workers.RateLimitClient): RateLimiter => ({
	limit: (key) =>
		dischargeRuntimeContext(client.limit({ key })).pipe(
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
		dischargeRuntimeContext(client.get(key)).pipe(
			Effect.flatMap((object) =>
				object === null ? Effect.succeed(Option.none<Uint8Array>()) : Effect.asSome(object.bytes()),
			),
			Effect.mapError((error) => new ObjectStoreError({ message: error.message, cause: error.cause })),
		),
})

const objectStoreError = (error: { readonly message: string; readonly cause: unknown }) =>
	new ObjectStoreError({ message: error.message, cause: error.cause })

const writableObjectStore = (client: Cloudflare.R2.ReadWriteBucketClient): WritableObjectStore => ({
	...objectStore(client),
	list: ({ prefix, startAfter, limit }) =>
		dischargeRuntimeContext(
			client.list({ prefix, limit, ...(startAfter === undefined ? undefined : { startAfter }) }),
		).pipe(
			Effect.mapBoth({
				onSuccess: (page) => ({
					objects: Arr.map(page.objects, (object) => ({
						key: object.key,
						uploadedAt: object.uploaded.getTime(),
					})),
					truncated: page.truncated,
				}),
				onFailure: objectStoreError,
			}),
		),
	put: (key, bytes, contentType) =>
		dischargeRuntimeContext(client.put(key, bytes, { httpMetadata: { contentType } })).pipe(
			Effect.asVoid,
			Effect.mapError((error) => new ObjectStoreError({ message: error.message, cause: error.cause })),
		),
	delete: (keys) =>
		keys.length === 0
			? Effect.void
			: dischargeRuntimeContext(client.delete([...keys])).pipe(
					Effect.mapError(
						(error) => new ObjectStoreError({ message: error.message, cause: error.cause }),
					),
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
 * the `ConfigProvider`, the ai service binding) and the `ChatSessions` port: the one place
 * a graph in this Worker gets its env from. `env` carries the `MAPLE_DB`
 * binding — real in the isolate, empty at plan time, where nothing reads it.
 */
export const apiPorts = (
	clients: ApiBindingClients,
	schemaApply: Cloudflare.WorkflowHandle<{ readonly orgId: string }>,
	env: Record<string, unknown>,
) =>
	Layer.mergeAll(
		Layer.succeed(VcsSyncQueueProducer, queueProducer(clients.vcsSync)),
		Layer.succeed(VcsBackfillQueueProducer, queueProducer(clients.vcsBackfill)),
		Layer.succeed(PlanetScaleWebhookQueueProducer, queueProducer(clients.planetScaleWebhooks)),
		Layer.succeed(AuditEventsQueueProducer, queueProducer(clients.auditEvents)),
		Layer.succeed(CancellationReviewQueueProducer, queueProducer(clients.cancellationReviews)),
		Layer.succeed(ApiV2RateLimit, limiter(clients.apiV2RateLimit)),
		Layer.succeed(ShareLinkRateLimit, limiter(clients.shareLinkRateLimit)),
		Layer.succeed(CliAuthRateLimit, limiter(clients.cliAuthRateLimit)),
		Layer.succeed(SelfHostedLoginRateLimit, limiter(clients.selfHostedLoginRateLimit)),
		Layer.succeed(McpOAuthRateLimit, limiter(clients.mcpOAuthRateLimit)),
		Layer.succeed(AwsEventsRateLimit, limiter(clients.awsEventsRateLimit)),
		Layer.succeed(DataSourceProductionCallLimit, limiter(clients.dataSourceProductionCallLimit)),
		Layer.succeed(DataSourceDevelopmentCallLimit, limiter(clients.dataSourceDevelopmentCallLimit)),
		Layer.succeed(DataSourceSqlQueryLimit, limiter(clients.dataSourceSqlQueryLimit)),
		Layer.succeed(ReplayBlobBucket, objectStore(clients.replayBlobs)),
		sourceMapBucketLayer(writableObjectStore(clients.sourceMaps)),
		Layer.unwrap(
			dischargeRuntimeContext(Effect.all([clients.statusKv.raw, clients.statusBucket.raw])).pipe(
				Effect.map(([kv, bucket]) => StatusPageStore.fromBindings(kv, bucket)),
			),
		),
		Layer.succeed(EmailSender, clients.email),
		Layer.succeed(SchemaApplyWorkflow, workflowStarter(schemaApply)),
		layerMapleDbConnection(env),
		envPorts(env),
		layerChatSessions(clients.chatSessions, env),
	)

export type ApiPortsLayer = ReturnType<typeof apiPorts>
