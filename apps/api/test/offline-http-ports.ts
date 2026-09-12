/** Offline graph fixtures. Every external operation fails rather than reaching a real service. */
import { Effect, Layer, Option } from "effect"
import { workerEnvLayer } from "@maple/infra/worker-runtime"
import {
	ApiV2RateLimit,
	AuditEventsQueueProducer,
	CliAuthRateLimit,
	MapleDbConnection,
	McpOAuthRateLimit,
	PlanetScaleWebhookQueueProducer,
	ReplayBlobBucket,
	VcsSyncQueueProducer,
} from "../src/platform/bindings"
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
	workerEnvLayer({
		TINYBIRD_HOST: "https://warehouse.invalid",
		TINYBIRD_TOKEN: "offline",
		MAPLE_ROOT_PASSWORD: "offline-benchmark-only",
		MAPLE_INGEST_KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
		MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
	}),
)
