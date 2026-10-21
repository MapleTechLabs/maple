import { Schema } from "effect"
import {
	IsoDateTimeString,
	PushSourcePlatform,
	SourceId,
	SourceKind,
	SourcePlatform,
	SourceResourceAttribute,
	SourceSignal,
} from "../primitives"
import { HttpTaggedError } from "./error-policy"

/** Resource attribute the ingest gateway stamps with the `src_` id of the source that sent the data. */
export const SOURCE_ID_ATTRIBUTE = "maple_source_id"

/** Shared by the API's validation and the sources form. */
export const SOURCE_LIMITS = {
	maxSourcesPerOrg: 100,
	maxResourceAttributes: 20,
	maxRateLimitRps: 100_000,
} as const

/** `paused` sources are accepted but their data is dropped; `expired` tokens are rejected. */
export const SourceTokenStatus = Schema.Literals(["active", "paused", "expired"])
export type SourceTokenStatus = Schema.Schema.Type<typeof SourceTokenStatus>

/** Worst first; mirrors `SOURCE_HEALTH_STATUSES` in `../source-health`. */
export const SourceHealthStatus = Schema.Literals([
	"disconnected",
	"failing",
	"stale",
	"paused",
	"pending",
	"healthy",
])
export type SourceHealthStatus = Schema.Schema.Type<typeof SourceHealthStatus>

export const SourceResourceCount = Schema.Struct({ total: Schema.Int, unhealthy: Schema.Int })

export class SourceHealth extends Schema.Class<SourceHealth>("SourceHealth")({
	status: SourceHealthStatus,
	lastDataAt: Schema.NullOr(IsoDateTimeString),
	problem: Schema.NullOr(Schema.String),
	/** Null unless the source stands for several resources (an account's zones, an org's repos). */
	resources: Schema.NullOr(SourceResourceCount),
}) {}

export class Source extends Schema.Class<Source>("Source")({
	id: SourceId,
	name: Schema.String,
	description: Schema.NullOr(Schema.String),
	platform: SourcePlatform,
	kind: SourceKind,
	/** Null for the default source (it uses the org's public/private pair) and pull sources. */
	keyPrefix: Schema.NullOr(Schema.String),
	/** The integration row a pull source stands for (a scrape target, a connection); null for push sources. */
	integrationId: Schema.NullOr(Schema.String),
	status: SourceTokenStatus,
	allowedSignals: Schema.NullOr(Schema.Array(SourceSignal)),
	rateLimitRps: Schema.NullOr(Schema.Int),
	resourceAttributes: Schema.Array(SourceResourceAttribute),
	expiresAt: Schema.NullOr(IsoDateTimeString),
	pausedAt: Schema.NullOr(IsoDateTimeString),
	pausedUntil: Schema.NullOr(IsoDateTimeString),
	lastUsedAt: Schema.NullOr(IsoDateTimeString),
	rolledAt: Schema.NullOr(IsoDateTimeString),
	createdAt: IsoDateTimeString,
	updatedAt: IsoDateTimeString,
	health: SourceHealth,
}) {}

/** Returned only by create and roll: the one time the raw token is visible. */
export class SourceWithSecret extends Schema.Class<SourceWithSecret>("SourceWithSecret")({
	source: Source,
	secret: Schema.String,
}) {}

export class CreateSourceRequest extends Schema.Class<CreateSourceRequest>("CreateSourceRequest")({
	name: Schema.String,
	platform: PushSourcePlatform,
	description: Schema.optionalKey(Schema.NullOr(Schema.String)),
	allowedSignals: Schema.optionalKey(Schema.NullOr(Schema.Array(SourceSignal))),
	rateLimitRps: Schema.optionalKey(Schema.NullOr(Schema.Int)),
	resourceAttributes: Schema.optionalKey(Schema.Array(SourceResourceAttribute)),
	expiresAtMs: Schema.optionalKey(Schema.NullOr(Schema.Number)),
}) {}

/** Omitted fields are unchanged; `null` clears a nullable field. */
export class UpdateSourceRequest extends Schema.Class<UpdateSourceRequest>("UpdateSourceRequest")({
	name: Schema.optionalKey(Schema.String),
	description: Schema.optionalKey(Schema.NullOr(Schema.String)),
	allowedSignals: Schema.optionalKey(Schema.NullOr(Schema.Array(SourceSignal))),
	rateLimitRps: Schema.optionalKey(Schema.NullOr(Schema.Int)),
	resourceAttributes: Schema.optionalKey(Schema.Array(SourceResourceAttribute)),
	expiresAtMs: Schema.optionalKey(Schema.NullOr(Schema.Number)),
}) {}

/** Hourly counts for one source; `hour` is the bucket start in epoch ms. */
export class SourceUsageBucket extends Schema.Class<SourceUsageBucket>("SourceUsageBucket")({
	hour: Schema.Number,
	spans: Schema.Number,
	logs: Schema.Number,
	/** Metric data points. */
	metrics: Schema.Number,
	/** Estimated stored bytes across every signal. */
	bytes: Schema.Number,
}) {}

export class SourceUsage extends Schema.Class<SourceUsage>("SourceUsage")({
	windowStart: Schema.Number,
	windowEnd: Schema.Number,
	buckets: Schema.Array(SourceUsageBucket),
}) {}

export class SourceUsageTotal extends Schema.Class<SourceUsageTotal>("SourceUsageTotal")({
	/** The public `src_` id stamped as `maple_source_id`. */
	sourceId: Schema.String,
	spans: Schema.Number,
	logs: Schema.Number,
	metrics: Schema.Number,
	bytes: Schema.Number,
}) {}

export class SourceUsageSummary extends Schema.Class<SourceUsageSummary>("SourceUsageSummary")({
	windowStart: Schema.Number,
	windowEnd: Schema.Number,
	totals: Schema.Array(SourceUsageTotal),
}) {}

export class SourceNotFoundError extends HttpTaggedError<SourceNotFoundError>()(
	"@maple/http/errors/SourceNotFoundError",
	{
		sourceId: SourceId,
		message: Schema.String,
	},
	{
		status: 404,
		code: "source_not_found",
		title: "Source not found",
		message: "No such source.",
		param: "id",
		retry: "never",
		recovery: "none",
		exposure: "redacted",
	},
) {}

export class SourceValidationError extends HttpTaggedError<SourceValidationError>()(
	"@maple/http/errors/SourceValidationError",
	{
		message: Schema.String,
	},
	{
		status: 400,
		code: "source_invalid",
		title: "Invalid source settings",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

export class SourcePersistenceError extends HttpTaggedError<SourcePersistenceError>()(
	"@maple/http/errors/SourcePersistenceError",
	{
		message: Schema.String,
	},
	{
		status: 503,
		code: "source_persistence_failed",
		title: "Sources are temporarily unavailable",
		message: "Sources are temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}
