/**
 * The gateway's pass-through tuning knobs: each reaches the task only when the deploy's
 * environment sets it, so the binary's own default (`AppConfig::from_env`) applies otherwise.
 */
import * as Config from "effect/Config"
import { optionalPlain, type PlainEnv } from "@maple/infra/env"
import { Array as Arr } from "effect"

const EMPTY: PlainEnv = {}

export const gatewayTuningEnv: Config.Config<PlainEnv> = Config.all([
	optionalPlain("INGEST_WAL_SEGMENT_MAX_BYTES"),
	optionalPlain("INGEST_WAL_S3_ORPHAN_AFTER_SECS"),
	optionalPlain("INGEST_WRITE_MODE"),
	optionalPlain("INGEST_BATCH_MAX_ROWS"),
	optionalPlain("INGEST_BATCH_MAX_BYTES"),
	optionalPlain("INGEST_BATCH_MAX_WAIT_MS"),
	optionalPlain("INGEST_ORG_QUEUE_MAX_BYTES"),
	optionalPlain("INGEST_ORG_MAX_IN_FLIGHT"),
	optionalPlain("INGEST_GCP_ORG_MAX_IN_FLIGHT"),
	optionalPlain("INGEST_REQUEST_TIMEOUT_SECS"),
	optionalPlain("INGEST_QUEUE_MAX_AGE_SECS"),
	// Customer ingest rules (docs/ingest-rules.md): the gateway defaults to on; set "false" only to
	// switch rule application off in an emergency.
	optionalPlain("INGEST_RULES_ENABLED"),
	optionalPlain("INGEST_RULES_CACHE_TTL_SECS"),
	optionalPlain("INGEST_MAX_REQUEST_BODY_BYTES"),
	optionalPlain("INGEST_MAX_DECODED_BODY_BYTES"),
	optionalPlain("INGEST_MAX_DECODE_HEAP_BYTES"),
	optionalPlain("INGEST_DECODE_MEMORY_BYTES"),
	optionalPlain("INGEST_EXPORT_MAX_ATTEMPTS"),
	optionalPlain("INGEST_TINYBIRD_CONCURRENCY_PER_SHARD"),
	optionalPlain("INGEST_REPLAY_MAX_SESSION_BYTES"),
	optionalPlain("AUTUMN_API_URL"),
	// Entitlement cache TTLs. The allow TTL is how soft a hard cap is.
	optionalPlain("AUTUMN_ENTITLEMENT_ALLOW_TTL_SECS"),
	optionalPlain("AUTUMN_ENTITLEMENT_DENY_TTL_SECS"),
	// 30s instead of the binary's 1s cuts Autumn track calls ~30x.
	optionalPlain("AUTUMN_FLUSH_INTERVAL_SECS", "30"),
	optionalPlain("INGEST_SHUTDOWN_DRAIN_SECS"),
]).pipe(Config.map((records) => Arr.reduce(records, EMPTY, (env, record) => ({ ...env, ...record }))))
