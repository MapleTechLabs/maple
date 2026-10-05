/**
 * The Cloudflare bindings the api's services reach, as Maple-owned ports.
 *
 * A service depends on one of these tags, never on the Worker env: the api
 * Worker provides them from alchemy's typed binding clients (`worker/bindings.ts`),
 * tests provide fakes, and a host without the binding (the alerting Worker,
 * the CLI) provides nothing — services that can degrade read the tag through
 * `Effect.serviceOption`. Every method keeps its failure in the typed channel.
 */
import type { ChatSessionClient } from "@maple/domain/chat-session-stub"
import { Context, type Effect, type Option, Schema } from "effect"

// ── Queues ───────────────────────────────────────────────────────────────────

export class QueueSendError extends Schema.TaggedError<QueueSendError>()(
	"@maple/api/platform/QueueSendError",
	{
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/**
 * The producer side of one Cloudflare Queue.
 *
 * BOUNDARY: bodies are opaque here on purpose — each producer service encodes
 * its job with that job's schema before it reaches this port, and the queue
 * carries JSON it never inspects.
 */
export interface QueueProducer {
	readonly sendBatch: (
		messages: ReadonlyArray<{ readonly body: unknown; readonly delaySeconds?: number | undefined }>,
	) => Effect.Effect<void, QueueSendError>
}

/** Vendor-agnostic VCS sync jobs (commit backfill + webhook deltas). */
export class VcsSyncQueueProducer extends Context.Service<VcsSyncQueueProducer, QueueProducer>()(
	"@maple/api/platform/VcsSyncQueueProducer",
) {}

/** PlanetScale webhook deliveries, decoupled from the receiving request. */
export class PlanetScaleWebhookQueueProducer extends Context.Service<
	PlanetScaleWebhookQueueProducer,
	QueueProducer
>()("@maple/api/platform/PlanetScaleWebhookQueueProducer") {}

/** Org audit-log entries on their way to the warehouse. */
export class AuditEventsQueueProducer extends Context.Service<AuditEventsQueueProducer, QueueProducer>()(
	"@maple/api/platform/AuditEventsQueueProducer",
) {}

// ── Rate limits ──────────────────────────────────────────────────────────────

export class RateLimitBindingError extends Schema.TaggedError<RateLimitBindingError>()(
	"@maple/api/platform/RateLimitBindingError",
	{
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/** One Cloudflare rate-limit binding. Callers scope keys under `MAPLE_ENVIRONMENT` so counters never cross deployments. */
export interface RateLimiter {
	readonly limit: (key: string) => Effect.Effect<{ readonly success: boolean }, RateLimitBindingError>
}

export class ApiV2RateLimit extends Context.Service<ApiV2RateLimit, RateLimiter>()(
	"@maple/api/platform/ApiV2RateLimit",
) {}
export class CliAuthRateLimit extends Context.Service<CliAuthRateLimit, RateLimiter>()(
	"@maple/api/platform/CliAuthRateLimit",
) {}
export class McpOAuthRateLimit extends Context.Service<McpOAuthRateLimit, RateLimiter>()(
	"@maple/api/platform/McpOAuthRateLimit",
) {}
export class McpToolsRateLimit extends Context.Service<McpToolsRateLimit, RateLimiter>()(
	"@maple/api/platform/McpToolsRateLimit",
) {}

// ── Object store (R2) ────────────────────────────────────────────────────────

export class ObjectStoreError extends Schema.TaggedError<ObjectStoreError>()(
	"@maple/api/platform/ObjectStoreError",
	{
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/** The read side of one bucket. */
export interface ObjectStore {
	/** The object's bytes, or `None` when there is no object under `key`. */
	readonly getBytes: (key: string) => Effect.Effect<Option.Option<Uint8Array>, ObjectStoreError>
}

/** Session-replay rrweb payloads, written by the ingest gateway. */
export class ReplayBlobBucket extends Context.Service<ReplayBlobBucket, ObjectStore>()(
	"@maple/api/platform/ReplayBlobBucket",
) {}

// ── Application database (Hyperdrive) ────────────────────────────────────────

/** What the Postgres layers dial: the Hyperdrive connection string and the identity attributes its spans carry. */
export interface DatabaseConnection {
	readonly connectionString: string
	/** Never contains credentials. */
	readonly attributes: Record<string, unknown>
}

/** The `MAPLE_DB` Hyperdrive, or `None` on a stage without an application database (PR previews). */
export class MapleDbConnection extends Context.Service<
	MapleDbConnection,
	Option.Option<DatabaseConnection>
>()("@maple/api/platform/MapleDbConnection") {}

// ── Workflows ────────────────────────────────────────────────────────────────

export class WorkflowStartError extends Schema.TaggedError<WorkflowStartError>()(
	"@maple/api/platform/WorkflowStartError",
	{
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/** Starts instances of one Cloudflare Workflow. */
export interface WorkflowStarter<Params> {
	readonly create: (params: Params) => Effect.Effect<void, WorkflowStartError>
}

/** The per-org ClickHouse schema apply, hosted by the api Worker. */
export class SchemaApplyWorkflow extends Context.Service<
	SchemaApplyWorkflow,
	WorkflowStarter<{ readonly orgId: string }>
>()("@maple/api/platform/SchemaApplyWorkflow") {}

// ── Email (send_email) ───────────────────────────────────────────────────────

export class EmailSendError extends Schema.TaggedError<EmailSendError>()(
	"@maple/api/platform/EmailSendError",
	{
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

export interface EmailMessage {
	readonly from: string
	readonly to: string
	readonly subject: string
	readonly html: string
	readonly replyTo?: string | undefined
}

export interface EmailSenderClient {
	readonly send: (message: EmailMessage) => Effect.Effect<{ readonly messageId: string }, EmailSendError>
}

/** The `send_email` binding, or `None` on a stage that does not bind it (everything but prd). */
export class EmailSender extends Context.Service<EmailSender, Option.Option<EmailSenderClient>>()(
	"@maple/api/platform/EmailSender",
) {}

// ── Service bindings to other Maple Workers ─────────────────────────────────

/** maple-ai, which serves `/mcp`, the chat surface and incident triage. `None` where the Worker does not bind it. */
export class AiWorkerFetcher extends Context.Service<AiWorkerFetcher, Option.Option<Fetcher>>()(
	"@maple/api/platform/AiWorkerFetcher",
) {}

/** The repository sandbox Worker. `None` on a deployment that did not provision one. */
export class SandboxFetcher extends Context.Service<SandboxFetcher, Option.Option<Fetcher>>()(
	"@maple/api/platform/SandboxFetcher",
) {}

// ── Chat sessions (Durable Object) ───────────────────────────────────────────

/** Addresses `ChatSession` Durable Objects, bound through alchemy (`chat-sessions.ts`). A host without the binding provides nothing. */
export interface ChatSessionsApi {
	readonly session: (sessionId: string) => ChatSessionClient
}

export class ChatSessions extends Context.Service<ChatSessions, ChatSessionsApi>()(
	"@maple/api/platform/ChatSessions",
) {}
