import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import { Schema } from "effect"
import { AuditedRead } from "../audit-log"
import { EndpointAccess, requires } from "../endpoint-access"
import { AuthorizationV2 } from "./auth"

/**
 * The Prometheus HTTP API (`/api/v1/*`) over Maple's metrics, so Grafana and other Prometheus
 * clients can use Maple as a Prometheus data source. Request parameters and response bodies follow
 * Prometheus exactly; errors are `{status:"error",errorType,error}` with 400, 422 or 503.
 */

const optionalString = (description: string) => Schema.optional(Schema.String).annotate({ description })

const matchParam = Schema.optional(Schema.Array(Schema.String)).annotate({
	description: 'Repeated series selector, e.g. `up{job="api"}`.',
})

/** Every Prometheus request parameter these endpoints read; each endpoint ignores the rest. */
export const PrometheusParams = Schema.Struct({
	query: optionalString("PromQL expression."),
	time: optionalString("Evaluation time: RFC3339 or Unix seconds. Defaults to now."),
	start: optionalString("Range start: RFC3339 or Unix seconds."),
	end: optionalString("Range end: RFC3339 or Unix seconds."),
	step: optionalString("Resolution: a duration like `30s` or float seconds."),
	timeout: optionalString(
		"Evaluation timeout for `query` and `query_range`: a duration like `30s`, applied to the whole evaluation. Each metric store read also stops at 30s.",
	),
	limit: optionalString("Maximum number of returned items."),
	metric: optionalString("Metric name to return metadata for."),
	"match[]": matchParam,
}).annotate({ identifier: "PrometheusParams", title: "Prometheus parameters" })

/** The same parameters as an `application/x-www-form-urlencoded` body, as Grafana POSTs them. */
export const PrometheusForm = PrometheusParams.pipe(HttpApiSchema.asFormUrlEncoded())

const status = Schema.Literal("success")

/** Prometheus' `warnings`: why a query matched nothing (with the nearest names), or that a limit cut it. */
const warnings = Schema.optionalKey(Schema.Array(Schema.String))

export const PrometheusQueryResponse = Schema.Struct({
	status,
	warnings,
	data: Schema.Struct({
		resultType: Schema.Literals(["matrix", "vector", "scalar", "string"]),
		result: Schema.Unknown,
	}),
}).annotate({
	identifier: "PrometheusQueryResponse",
	title: "Prometheus query response",
	description: 'Values are `[<unix seconds>, "<value>"]` pairs, as Prometheus returns them.',
})

export const PrometheusStringListResponse = Schema.Struct({
	status,
	warnings,
	data: Schema.Array(Schema.String),
}).annotate({ identifier: "PrometheusStringListResponse", title: "Prometheus string list" })

export const PrometheusSeriesResponse = Schema.Struct({
	status,
	warnings,
	data: Schema.Array(Schema.Record(Schema.String, Schema.String)),
}).annotate({ identifier: "PrometheusSeriesResponse", title: "Prometheus series" })

export const PrometheusMetadataResponse = Schema.Struct({
	status,
	data: Schema.Record(
		Schema.String,
		Schema.Array(
			Schema.Struct({
				type: Schema.Literals(["counter", "gauge", "histogram"]),
				help: Schema.String,
				unit: Schema.String,
			}),
		),
	),
}).annotate({ identifier: "PrometheusMetadataResponse", title: "Prometheus metadata" })

export const PrometheusBuildInfoResponse = Schema.Struct({
	status,
	data: Schema.Struct({
		version: Schema.String,
		revision: Schema.String,
		branch: Schema.String,
		buildUser: Schema.String,
		buildDate: Schema.String,
		goVersion: Schema.String,
		vendor: Schema.String,
	}),
}).annotate({ identifier: "PrometheusBuildInfoResponse", title: "Prometheus build info" })

export const PrometheusExemplarsResponse = Schema.Struct({
	status,
	data: Schema.Array(Schema.Unknown),
}).annotate({ identifier: "PrometheusExemplarsResponse", title: "Prometheus exemplars" })

export const PrometheusFormatQueryResponse = Schema.Struct({
	status,
	data: Schema.String,
}).annotate({ identifier: "PrometheusFormatQueryResponse", title: "Prometheus formatted query" })

export const PrometheusRulesResponse = Schema.Struct({
	status,
	data: Schema.Struct({ groups: Schema.Array(Schema.Unknown) }),
}).annotate({ identifier: "PrometheusRulesResponse", title: "Prometheus rules" })

export const PrometheusAlertsResponse = Schema.Struct({
	status,
	data: Schema.Struct({ alerts: Schema.Array(Schema.Unknown) }),
}).annotate({ identifier: "PrometheusAlertsResponse", title: "Prometheus alerts" })

export const PrometheusConfigResponse = Schema.Struct({
	status,
	data: Schema.Struct({ yaml: Schema.String }),
}).annotate({ identifier: "PrometheusConfigResponse", title: "Prometheus config" })

export const PrometheusFlagsResponse = Schema.Struct({
	status,
	data: Schema.Record(Schema.String, Schema.String),
}).annotate({ identifier: "PrometheusFlagsResponse", title: "Prometheus flags" })

const docs = (identifier: string, summary: string, description: string) =>
	OpenApi.annotations({ identifier, summary, description: `${description} Requires \`metrics:read\`.` })

const readGet = <const Name extends string, const Path extends `/${string}`, S extends Schema.Top>(
	name: Name,
	path: Path,
	success: S,
) => HttpApiEndpoint.get(name, path, { query: PrometheusParams, success })

/** The form-POST twin of a GET; Prometheus treats the two the same, and so does the scope check. */
const readPost = <const Name extends string, const Path extends `/${string}`, S extends Schema.Top>(
	name: Name,
	path: Path,
	success: S,
) =>
	HttpApiEndpoint.post(name, path, { query: PrometheusParams, payload: PrometheusForm, success }).annotate(
		EndpointAccess,
		requires("telemetry:read"),
	)

const QUERY = "Evaluates an instant PromQL query at `time`."
const RANGE = "Evaluates a PromQL query over `[start, end]` every `step`."
const SERIES = "Lists the label sets of the series the `match[]` selectors select in `[start, end]`."
const LABELS = "Lists label names, of the `match[]` series when given."
const EXEMPLARS = "Exemplar queries; Maple returns none."
const FORMAT = "Pretty-prints a PromQL expression the way Prometheus formats it."
const NONE = "Maple evaluates no recording or alerting rules, so the list is always empty."

export class V2PrometheusApiGroup extends HttpApiGroup.make("prometheus")
	.add(
		readGet("query", "/query", PrometheusQueryResponse).annotateMerge(
			docs("prometheusQuery", "PromQL instant query", QUERY),
		),
	)
	.add(
		readPost("queryPost", "/query", PrometheusQueryResponse).annotateMerge(
			docs("prometheusQueryPost", "PromQL instant query (form POST)", QUERY),
		),
	)
	.add(
		readGet("queryRange", "/query_range", PrometheusQueryResponse).annotateMerge(
			docs("prometheusQueryRange", "PromQL range query", RANGE),
		),
	)
	.add(
		readPost("queryRangePost", "/query_range", PrometheusQueryResponse).annotateMerge(
			docs("prometheusQueryRangePost", "PromQL range query (form POST)", RANGE),
		),
	)
	.add(
		readGet("series", "/series", PrometheusSeriesResponse).annotateMerge(
			docs("prometheusSeries", "Find series", SERIES),
		),
	)
	.add(
		readPost("seriesPost", "/series", PrometheusSeriesResponse).annotateMerge(
			docs("prometheusSeriesPost", "Find series (form POST)", SERIES),
		),
	)
	.add(
		readGet("labels", "/labels", PrometheusStringListResponse).annotateMerge(
			docs("prometheusLabels", "List label names", LABELS),
		),
	)
	.add(
		readPost("labelsPost", "/labels", PrometheusStringListResponse).annotateMerge(
			docs("prometheusLabelsPost", "List label names (form POST)", LABELS),
		),
	)
	.add(
		HttpApiEndpoint.get("labelValues", "/label/:name/values", {
			params: { name: Schema.String },
			query: PrometheusParams,
			success: PrometheusStringListResponse,
		}).annotateMerge(
			docs(
				"prometheusLabelValues",
				"List label values",
				"Lists the values of one label, of the `match[]` series when given. `__name__` lists metric names.",
			),
		),
	)
	.add(
		readGet("metadata", "/metadata", PrometheusMetadataResponse).annotateMerge(
			docs(
				"prometheusMetadata",
				"Metric metadata",
				"Type, help and unit of each metric family, from the metric catalog.",
			),
		),
	)
	.add(
		HttpApiEndpoint.get("buildInfo", "/status/buildinfo", {
			success: PrometheusBuildInfoResponse,
		}).annotateMerge(
			docs(
				"prometheusBuildInfo",
				"Build information",
				"The Prometheus version this API is compatible with, so clients enable the matching features.",
			),
		),
	)
	.add(
		readGet("exemplars", "/query_exemplars", PrometheusExemplarsResponse).annotateMerge(
			docs("prometheusExemplars", "Query exemplars", EXEMPLARS),
		),
	)
	.add(
		readPost("exemplarsPost", "/query_exemplars", PrometheusExemplarsResponse).annotateMerge(
			docs("prometheusExemplarsPost", "Query exemplars (form POST)", EXEMPLARS),
		),
	)
	.add(
		readGet("formatQuery", "/format_query", PrometheusFormatQueryResponse).annotateMerge(
			docs("prometheusFormatQuery", "Format a query", FORMAT),
		),
	)
	.add(
		readPost("formatQueryPost", "/format_query", PrometheusFormatQueryResponse).annotateMerge(
			docs("prometheusFormatQueryPost", "Format a query (form POST)", FORMAT),
		),
	)
	.add(
		readGet("rules", "/rules", PrometheusRulesResponse).annotateMerge(
			docs("prometheusRules", "List rules", NONE),
		),
	)
	.add(
		readGet("alerts", "/alerts", PrometheusAlertsResponse).annotateMerge(
			docs("prometheusAlerts", "List active alerts", NONE),
		),
	)
	.add(
		HttpApiEndpoint.get("config", "/status/config", { success: PrometheusConfigResponse }).annotateMerge(
			docs(
				"prometheusConfig",
				"Configuration",
				"Maple has no Prometheus configuration; `yaml` is empty.",
			),
		),
	)
	.add(
		HttpApiEndpoint.get("flags", "/status/flags", { success: PrometheusFlagsResponse }).annotateMerge(
			docs(
				"prometheusFlags",
				"Flags",
				"Maple has no Prometheus command-line flags; the object is empty.",
			),
		),
	)
	.prefix("/v2/metrics/prometheus/api/v1")
	.middleware(AuthorizationV2)
	.annotate(AuditedRead, "telemetry.read")
	.annotateMerge(
		OpenApi.annotations({
			title: "Prometheus",
			description:
				"The Prometheus HTTP query API over Maple metrics, for Grafana and other Prometheus clients.",
		}),
	)
	.annotate(EndpointAccess, requires("telemetry:read")) {}
