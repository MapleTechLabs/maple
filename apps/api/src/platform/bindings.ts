/**
 * The Cloudflare bindings the api's services reach, as Maple-owned ports.
 *
 * A service depends on one of these tags, never on the Worker env: the api
 * Worker provides them from alchemy's typed binding clients (`worker/bindings.ts`),
 * tests provide fakes, and a host without the binding (the alerting Worker,
 * the CLI) provides nothing — services that can degrade read the tag through
 * `Effect.serviceOption`. Every method keeps its failure in the typed channel.
 */
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
	readonly send: (
		body: unknown,
		options?: { readonly delaySeconds?: number | undefined },
	) => Effect.Effect<void, QueueSendError>
	readonly sendBatch: (
		messages: ReadonlyArray<{ readonly body: unknown }>,
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

/** One Cloudflare rate-limit binding, plus the stage partition its keys are scoped under. */
export interface RateLimiter {
	/** `API_V2_RATE_LIMIT_PARTITION` — the stage, so counters never cross deployments. */
	readonly partition: string | undefined
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

// ── Key-value store (KV) ─────────────────────────────────────────────────────

export class KeyValueStoreError extends Schema.TaggedError<KeyValueStoreError>()(
	"@maple/api/platform/KeyValueStoreError",
	{
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/** One KV namespace, JSON values. */
export interface KeyValueStore {
	readonly getJson: (key: string) => Effect.Effect<Option.Option<unknown>, KeyValueStoreError>
	readonly put: (
		key: string,
		value: string,
		options: { readonly expirationTtl: number },
	) => Effect.Effect<void, KeyValueStoreError>
}

/** MCP session transcripts, so the next isolate can find a session this one issued. */
export class McpSessionStore extends Context.Service<McpSessionStore, KeyValueStore>()(
	"@maple/api/platform/McpSessionStore",
) {}
