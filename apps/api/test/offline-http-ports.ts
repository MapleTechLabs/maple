/** Offline graph fixtures. Every external operation fails rather than reaching a real service. */
import { Effect, Layer, Option } from "effect"
import { fakeChatSessionsLayer } from "@maple/backend/platform/chat-sessions-fake"
import { envPorts } from "@maple/backend/platform/env-ports"
import {
	ApiV2RateLimit,
	AuditEventsQueueProducer,
	CliAuthRateLimit,
	EmailSender,
	MapleDbConnection,
	McpOAuthRateLimit,
	PlanetScaleWebhookQueueProducer,
	ReplayBlobBucket,
	SchemaApplyWorkflow,
	VcsSyncQueueProducer,
} from "@maple/backend/platform/bindings"
const rejectIO = () => Effect.die("Unexpected external I/O in cold-path probe")
const queue = { sendBatch: rejectIO }
const limiter = { limit: rejectIO }
export const offlinePorts = Layer.mergeAll(
	Layer.succeed(VcsSyncQueueProducer, queue),
	Layer.succeed(PlanetScaleWebhookQueueProducer, queue),
	Layer.succeed(AuditEventsQueueProducer, queue),
	Layer.succeed(ApiV2RateLimit, limiter),
	Layer.succeed(CliAuthRateLimit, limiter),
	Layer.succeed(McpOAuthRateLimit, limiter),
	Layer.succeed(ReplayBlobBucket, { getBytes: rejectIO }),
	Layer.succeed(MapleDbConnection, Option.none()),
	Layer.succeed(EmailSender, Option.none()),
	Layer.succeed(SchemaApplyWorkflow, { create: rejectIO }),
	// Every session call fails: the probe must not reach a Durable Object.
	fakeChatSessionsLayer(() => ({})),
	envPorts({
		TINYBIRD_HOST: "https://warehouse.invalid",
		TINYBIRD_TOKEN: "offline",
		MAPLE_ROOT_PASSWORD: "offline-benchmark-only",
		MAPLE_INGEST_KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
		MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
	}),
)
