import { Schema } from "effect"
import { IsoDateTimeString } from "../primitives"
import { HttpTaggedError } from "./error-policy"

/** Bounds the ingest gateway clamps the ratio to; the API refuses values outside them. */
export const TRACE_SAMPLE_RATIO_MIN = 0.000001
export const TRACE_SAMPLE_RATIO_MAX = 1
/** The column is a Postgres int4. */
export const ALWAYS_KEEP_SLOW_SPANS_MS_MAX = 2_147_483_647

export const TraceSampleRatio = Schema.Number.check(
	Schema.isFinite(),
	Schema.isBetween({ minimum: TRACE_SAMPLE_RATIO_MIN, maximum: TRACE_SAMPLE_RATIO_MAX }),
)

export const AlwaysKeepSlowSpansMs = Schema.Number.check(
	Schema.isInt(),
	Schema.isBetween({ minimum: 1, maximum: ALWAYS_KEEP_SLOW_SPANS_MS_MAX }),
)

/** What the gateway applies when an org has no policy row. */
export const DEFAULT_TRACE_SAMPLING_POLICY = {
	traceSampleRatio: 1,
	alwaysKeepErrorSpans: true,
	alwaysKeepSlowSpansMs: null,
} as const

export class TraceSamplingPolicyDocument extends Schema.Class<TraceSamplingPolicyDocument>(
	"TraceSamplingPolicyDocument",
)({
	traceSampleRatio: TraceSampleRatio,
	alwaysKeepErrorSpans: Schema.Boolean,
	alwaysKeepSlowSpansMs: Schema.NullOr(AlwaysKeepSlowSpansMs),
	/** `null` while the org runs on the defaults (no stored policy). */
	updatedAt: Schema.NullOr(IsoDateTimeString),
}) {}

export class TraceSamplingPolicyUpdateRequest extends Schema.Class<TraceSamplingPolicyUpdateRequest>(
	"TraceSamplingPolicyUpdateRequest",
)({
	traceSampleRatio: Schema.optionalKey(TraceSampleRatio),
	alwaysKeepErrorSpans: Schema.optionalKey(Schema.Boolean),
	alwaysKeepSlowSpansMs: Schema.optionalKey(Schema.NullOr(AlwaysKeepSlowSpansMs)),
}) {}

export class TraceSamplingPersistenceError extends HttpTaggedError<TraceSamplingPersistenceError>()(
	"@maple/http/errors/TraceSamplingPersistenceError",
	{
		message: Schema.String,
	},
	{
		status: 503,
		code: "trace_sampling_unavailable",
		title: "Trace sampling is temporarily unavailable",
		message: "Trace sampling settings are temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}
