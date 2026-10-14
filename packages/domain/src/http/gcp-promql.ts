/**
 * Live PromQL over a customer's Google Cloud Monitoring metrics, read through Google's
 * Prometheus-compatible API with each connection's read-only account. Nothing is stored. One call
 * per project: an aggregation never spans projects, and every series carries `project_id`.
 */
import { Schema } from "effect"
import { GcpProjectId } from "../primitives"
import { TinybirdDateTime } from "../query-engine"
import { HttpTaggedError } from "./error-policy"
import { BucketSeconds } from "./query-engine"

/** Projects one query reads. Above it the caller names the projects. */
export const GCP_PROMQL_MAX_PROJECTS = 20
export const GCP_PROMQL_MAX_QUERY_LENGTH = 4_000
export const GCP_PROMQL_MIN_STEP_SECONDS = 60
export const GCP_PROMQL_MAX_POINTS = 11_000
/** Series in one answer, across its projects. */
export const GCP_PROMQL_MAX_SERIES = 500
export const GCP_METRIC_SEARCH_MAX_LIMIT = 200

/** `TinybirdDateTime` is UTC without a zone marker. */
export const gcpPromQlTimeMs = (value: string): number => Date.parse(`${value.replace(" ", "T")}Z`)

const PromQlQuery = Schema.String.check(
	Schema.isTrimmed(),
	Schema.isMinLength(1),
	Schema.isMaxLength(GCP_PROMQL_MAX_QUERY_LENGTH),
)

/** A subset of the organization's projects; any other project is refused. */
const PromQlProjects = Schema.Array(GcpProjectId).check(
	Schema.isMinLength(1),
	Schema.isMaxLength(GCP_PROMQL_MAX_PROJECTS),
)

/** The pattern admits `2026-13-45 99:99:99`, which parses to NaN. */
const PromQlTime = TinybirdDateTime.check(
	Schema.makeFilter((time: string) => !Number.isNaN(gcpPromQlTimeMs(time)) || "must be a valid datetime"),
)

export class GcpPromQlRangeRequest extends Schema.Class<GcpPromQlRangeRequest>("GcpPromQlRangeRequest")(
	Schema.Struct({
		query: PromQlQuery,
		startTime: PromQlTime,
		endTime: PromQlTime,
		/** Point spacing. Start and end are aligned to it. */
		stepSeconds: BucketSeconds.check(
			Schema.isGreaterThanOrEqualTo(GCP_PROMQL_MIN_STEP_SECONDS),
			Schema.isLessThanOrEqualTo(86_400),
		),
		projects: Schema.optionalKey(PromQlProjects),
	}).check(
		Schema.makeFilter(
			(request: {
				readonly startTime: string
				readonly endTime: string
				readonly stepSeconds: number
			}) => {
				const extentMs = gcpPromQlTimeMs(request.endTime) - gcpPromQlTimeMs(request.startTime)
				if (extentMs <= 0) return "endTime must be after startTime"
				// Google's limit per series, refused here as a request error.
				return (
					extentMs / 1000 / request.stepSeconds <= GCP_PROMQL_MAX_POINTS ||
					`at most ${GCP_PROMQL_MAX_POINTS} points per series: widen stepSeconds`
				)
			},
			{ identifier: "GcpPromQlWindow" },
		),
	),
) {}

export class GcpPromQlInstantRequest extends Schema.Class<GcpPromQlInstantRequest>("GcpPromQlInstantRequest")(
	{
		query: PromQlQuery,
		time: PromQlTime,
		projects: Schema.optionalKey(PromQlProjects),
	},
) {}

export const GcpPromQlSeries = Schema.Struct({
	/** Google's labels, `project_id` always among them. */
	labels: Schema.Record(Schema.String, Schema.String),
	/** `[epoch seconds, value]`, NaN and infinities dropped. An instant query has one point. */
	points: Schema.Array(Schema.Tuple([Schema.Number, Schema.Number])),
})
export type GcpPromQlSeries = Schema.Schema.Type<typeof GcpPromQlSeries>

/** A project or a connection's scope that could not be read, and what to do about it. */
export const GcpPromQlFailure = Schema.Struct({
	/** `projects/<id>`, `folders/<number>` or `organizations/<number>`. */
	scope: Schema.String,
	message: Schema.String,
})
export type GcpPromQlFailure = Schema.Schema.Type<typeof GcpPromQlFailure>

export class GcpPromQlResult extends Schema.Class<GcpPromQlResult>("GcpPromQlResult")({
	resultType: Schema.Literals(["matrix", "vector"]),
	series: Schema.Array(GcpPromQlSeries),
	/** The projects that answered. */
	projects: Schema.Array(GcpProjectId),
	/** What could not be read. The rest is still returned. */
	failures: Schema.Array(GcpPromQlFailure),
}) {}

/** A Cloud Monitoring metric type, e.g. `run.googleapis.com/request_count`. */
export const GcpMetricType = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][\w./-]{0,254}$/u))

export class GcpMetricSearchResponse extends Schema.Class<GcpMetricSearchResponse>("GcpMetricSearchResponse")(
	{
		/** The project whose metric list was searched. */
		projectId: GcpProjectId,
		/** Metric names in PromQL's UTF-8 form, in name order. Distributions end in `_bucket`, `_count`, `_sum`. */
		metrics: Schema.Array(Schema.String),
	},
) {}

/** What a starter query needs to know about a metric type. */
export class GcpMetricDescriptor extends Schema.Class<GcpMetricDescriptor>("GcpMetricDescriptor")({
	type: Schema.String,
	/** `GAUGE`, `DELTA` or `CUMULATIVE`. */
	metricKind: Schema.String,
	/** `BOOL`, `INT64`, `DOUBLE`, `STRING`, `DISTRIBUTION` or `MONEY`. */
	valueType: Schema.String,
	unit: Schema.String,
	description: Schema.String,
	/** More than one: a query needs a `monitored_resource` matcher. */
	monitoredResourceTypes: Schema.Array(Schema.String),
	labels: Schema.Array(Schema.Struct({ key: Schema.String, description: Schema.String })),
}) {}

/** Google refused the PromQL itself. The message is Google's. */
export class GcpPromQlInvalidQueryError extends HttpTaggedError<GcpPromQlInvalidQueryError>()(
	"@maple/http/errors/GcpPromQlInvalidQueryError",
	{ message: Schema.String, projectId: GcpProjectId },
	{
		status: 400,
		code: "gcp_promql_invalid",
		title: "Invalid PromQL query",
		param: "query",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

/** The connections cover more projects than one query reads. */
export class GcpPromQlTooManyProjectsError extends HttpTaggedError<GcpPromQlTooManyProjectsError>()(
	"@maple/http/errors/GcpPromQlTooManyProjectsError",
	{ message: Schema.String, projects: Schema.Array(GcpProjectId) },
	{
		status: 400,
		code: "gcp_promql_too_many_projects",
		title: "Too many projects",
		param: "projects",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

/** The answer holds more than `GCP_PROMQL_MAX_SERIES` series. Never truncated. */
export class GcpPromQlTooManySeriesError extends HttpTaggedError<GcpPromQlTooManySeriesError>()(
	"@maple/http/errors/GcpPromQlTooManySeriesError",
	{ message: Schema.String, series: Schema.Number },
	{
		status: 400,
		code: "gcp_promql_too_many_series",
		title: "Too many series",
		param: "query",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

/** Nothing could be read: every project or connection failed. */
export class GcpPromQlFailedError extends HttpTaggedError<GcpPromQlFailedError>()(
	"@maple/http/errors/GcpPromQlFailedError",
	{ message: Schema.String, failures: Schema.Array(GcpPromQlFailure) },
	{
		status: 409,
		code: "gcp_promql_failed",
		title: "Google Cloud could not be read",
		retry: "never",
		recovery: "none",
		exposure: "public_message",
	},
) {}

/** This deployment has no Google identity to read with. */
export class GcpPromQlUnavailableError extends HttpTaggedError<GcpPromQlUnavailableError>()(
	"@maple/http/errors/GcpPromQlUnavailableError",
	{ message: Schema.String },
	{
		status: 409,
		code: "gcp_promql_unavailable",
		title: "Live Google Cloud queries are not available",
		retry: "never",
		recovery: "none",
		exposure: "public_message",
	},
) {}
