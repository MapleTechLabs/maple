import { McpInvalidInputError, McpQueryBudgetError, McpQueryError, type McpToolRegistrar } from "./types"
import { describeInvalidQuerySpec, tokensFor } from "../lib/query-spec-tokens"
import { Effect, Schema } from "effect"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { QueryEngineService } from "@maple/backend/services/warehouse/QueryEngineService"
import { MetricType, QuerySpec } from "@maple/query-engine"
import { ProductEventKind } from "@maple/domain/query-engine"
import { QueryDataOutput } from "@maple/domain/mcp-outputs"
import { formatBucket, formatMetricValue, inferQueryDataUnit } from "../lib/format-query-result"
import { warehouseReadToMcpHandlers } from "../lib/map-warehouse-error"
import { formatNumber } from "../lib/format"
import * as P from "../lib/params"
import { LOG_SEVERITIES } from "./search-logs"
import { doc, type NextCall, type ToolDoc } from "../lib/tool-doc"
import { QUERY_BUILDER_DATA_SOURCES, type QueryResultContract } from "@maple/query-model"

const WINDOW = P.timeWindow({ defaultHours: 6 })

const decodeQuerySpec = Schema.decodeUnknownEffect(QuerySpec)

type Output = typeof QueryDataOutput.Type

const queryDataSchema = Schema.Struct({
	source: P.oneOf(
		QUERY_BUILDER_DATA_SOURCES,
		"'traces' for request/span analysis (latency, errors, throughput); 'logs' for log volume; " +
			"'metrics' for a custom metric (needs metric_name and metric_type from list_metrics); " +
			"'product_events' for track() events, page views and server events (names from list_product_events).",
	),
	kind: P.oneOf(
		["timeseries", "breakdown"] as const satisfies ReadonlyArray<QueryResultContract>,
		"'timeseries' for how a value changed over time; 'breakdown' for top-N or distribution. " +
			"Pick the right one first rather than calling twice.",
	),
	metric: P.optionalText(
		"Traces: count, avg_duration, p50_duration, p95_duration, p99_duration, error_rate (0-1 ratio), " +
			"apdex (needs apdex_threshold_ms). Logs: count. Product events: count, sessions, persons, users, visitors. " +
			"Metrics: avg, sum, min, max, count, rate, increase (breakdown: avg, sum, count only); " +
			"prefer rate or increase for monotonic sums. Default: count, or avg for metrics.",
	),
	group_by: P.optionalText(
		"Traces: service, span_name, status_code, http_method, attribute. Logs: service, severity. " +
			"Metrics: service, attribute, resource_attribute. " +
			"Product events: event_name, kind, source, host, page_path, service, group, attribute. " +
			"'attribute' needs attribute_key. Timeseries also take 'none' (the default); breakdown defaults to service.",
	),
	...WINDOW.fields,
	service: P.service(),
	// Traces-specific
	span_name: P.optionalText("Filter by span name (traces only)"),
	root_spans_only: P.optionalFlag("Only include root spans (traces only)"),
	environments: P.optionalList(
		"Only these deployment environments (traces only; explore_attributes source=services lists them)",
	),
	commit_shas: P.optionalList("Commit SHAs to filter (traces only)"),
	apdex_threshold_ms: P.optionalNumber("Apdex threshold in ms (traces only; needed for metric=apdex)"),
	// Logs-specific
	severity: P.optionalOneOf(LOG_SEVERITIES, "Only this log severity (logs only)"),
	// Product-events-specific
	event_name: P.optionalList("Only these event names (product_events only)"),
	event_kind: Schema.optional(Schema.Array(ProductEventKind)).annotate({
		description: "Only these event kinds (product_events only)",
	}),
	host: P.optionalText("Only events fired on this site host (product_events only)"),
	page_path: P.optionalText("Only events fired on this page path (product_events only)"),
	// Metrics-specific
	metric_name: P.optionalText("The metric, from list_metrics (source=metrics only)"),
	metric_type: P.optionalOneOf(MetricType.literals, "Type of `metric_name`, as list_metrics reports it"),
	// Shared attribute filtering
	attribute_key: P.optionalText("Attribute to filter on, or to group by with group_by=attribute"),
	attribute_value: P.optionalText("Exact value for attribute_key"),
	bucket_seconds: P.optionalNumber("Bucket width in seconds (timeseries only; auto-computed when omitted)"),
	limit: P.limit({ default: 10, max: 100, description: "Max rows of a breakdown" }),
})

type Params = typeof queryDataSchema.Type

const queryDataDescription =
	"Aggregate traces, logs, metrics or product events into a timeseries or a top-N breakdown. " +
	"Start here for trends, comparisons and top-N; for errors prefer find_errors and error_detail; " +
	"for a shape this tool cannot express, run_sql. Applied defaults are listed in the result."

/** Default metric/group_by per source, as `[default, available]` for the decisions list. */
const DEFAULT_METRIC = {
	traces: ["count", "count, avg_duration, p50_duration, p95_duration, p99_duration, error_rate, apdex"],
	logs: ["count", "count"],
	product_events: ["count", "count, sessions, persons, users, visitors"],
	metrics: ["avg", "avg, sum, min, max, count, rate, increase"],
} as const

const DEFAULT_GROUP_BY = {
	traces: {
		timeseries: ["none", "service, span_name, status_code, http_method, attribute, none"],
		breakdown: ["service", "service, span_name, status_code, http_method, attribute"],
	},
	logs: { timeseries: ["none", "service, severity, none"], breakdown: ["service", "service, severity"] },
	product_events: {
		timeseries: ["none", "event_name, kind, source, host, page_path, service, group, attribute, none"],
		breakdown: ["event_name", "event_name, kind, source, host, page_path, service, group, attribute"],
	},
	metrics: {
		timeseries: ["none", "service, attribute, none"],
		breakdown: ["service", "service, attribute"],
	},
} as const

const attributeFilterOf = (params: Params) =>
	params.attribute_key === undefined
		? undefined
		: {
				key: params.attribute_key,
				...(params.attribute_value === undefined
					? { mode: "exists" }
					: { value: params.attribute_value, mode: "equals" }),
			}

/**
 * The query as plain data. It is decoded against `QuerySpec` afterwards, which checks every
 * token and brand, so this stays free of casts.
 */
const buildRawSpec = (params: Params, metric: string, groupBy: string): Record<string, unknown> => {
	const attributeFilter = attributeFilterOf(params)
	const isBreakdown = params.kind === "breakdown"
	const queryFields = {
		kind: params.kind,
		source: params.source,
		metric,
		groupBy: isBreakdown ? groupBy : [groupBy],
		...(isBreakdown
			? { limit: params.limit }
			: params.bucket_seconds
				? { bucketSeconds: params.bucket_seconds }
				: undefined),
	}
	const withFilters = (filters: Record<string, unknown>) =>
		Object.keys(filters).length > 0 ? { ...queryFields, filters } : queryFields

	switch (params.source) {
		case "traces":
			return withFilters({
				...(params.service && { serviceName: params.service }),
				...(params.span_name && { spanName: params.span_name }),
				...(params.root_spans_only && { rootSpansOnly: true }),
				...(params.environments &&
					params.environments.length > 0 && { environments: params.environments }),
				...(params.commit_shas &&
					params.commit_shas.length > 0 && { commitShas: params.commit_shas }),
				...(params.group_by === "attribute" &&
					params.attribute_key && { groupByAttributeKeys: [params.attribute_key] }),
				...(attributeFilter && { attributeFilters: [attributeFilter] }),
				...(params.apdex_threshold_ms && { apdexThresholdMs: params.apdex_threshold_ms }),
			})
		case "logs":
			return withFilters({
				...(params.service && { serviceName: params.service }),
				...(params.severity && { severity: params.severity }),
			})
		case "product_events":
			return withFilters({
				...(params.event_name && params.event_name.length > 0 && { eventNames: params.event_name }),
				...(params.event_kind && params.event_kind.length > 0 && { kinds: params.event_kind }),
				...(params.host && { hosts: [params.host] }),
				...(params.page_path && { pagePaths: [params.page_path] }),
				...(params.service && { serviceNames: [params.service] }),
				...(params.group_by === "attribute" &&
					params.attribute_key && { groupByAttributeKey: params.attribute_key }),
				...(params.group_by !== "attribute" &&
					attributeFilter && { attributeFilters: [attributeFilter] }),
			})
		case "metrics":
			return {
				...queryFields,
				// Breakdowns take `attribute` or `service` only.
				groupBy: isBreakdown ? (groupBy === "attribute" ? "attribute" : "service") : [groupBy],
				filters: {
					metricName: params.metric_name,
					metricType: params.metric_type,
					...(params.service && { serviceName: params.service }),
					...(params.group_by === "attribute" &&
						params.attribute_key && { groupByAttributeKey: params.attribute_key }),
					...(params.group_by !== "attribute" &&
						attributeFilter && { attributeFilters: [attributeFilter] }),
				},
			}
	}
}

const queryContextOf = (params: Params): Output["queryContext"] => {
	const attributeFilter = attributeFilterOf(params)
	return {
		source: params.source,
		...(params.service && { serviceName: params.service }),
		...(params.span_name && { spanName: params.span_name }),
		...(params.root_spans_only && { rootSpansOnly: true }),
		...(params.environments && params.environments.length > 0 && { environments: params.environments }),
		...(params.commit_shas && params.commit_shas.length > 0 && { commitShas: params.commit_shas }),
		...(params.severity && { severity: params.severity }),
		...(params.event_name && params.event_name.length > 0 && { eventName: params.event_name.join(",") }),
		...(params.event_kind && params.event_kind.length > 0 && { eventKind: params.event_kind.join(",") }),
		...(params.host && { host: params.host }),
		...(params.page_path && { pagePath: params.page_path }),
		...(params.metric_name && { metricName: params.metric_name }),
		...(params.metric_type && { metricType: params.metric_type }),
		...(params.apdex_threshold_ms && { apdexThresholdMs: params.apdex_threshold_ms }),
		...(params.bucket_seconds && { bucketSeconds: params.bucket_seconds }),
		...(params.kind === "breakdown" && { limit: params.limit }),
		...(attributeFilter && { attributeFilters: [attributeFilter] }),
	}
}

const nextCallsFor = (output: Output): ReadonlyArray<NextCall> => {
	const ctx = output.queryContext
	const window = { start_time: output.timeRange.start, end_time: output.timeRange.end }
	switch (ctx.source) {
		case "traces": {
			const top = output.result.kind === "breakdown" ? output.result.data[0]?.name : undefined
			const service = output.groupBy === "service" && top !== undefined ? top : ctx.serviceName
			const spanName = output.groupBy === "span_name" && top !== undefined ? top : ctx.spanName
			return [
				doc.next(
					"search_traces",
					{ ...window, service, span_name: spanName },
					output.result.kind === "breakdown"
						? "find specific traces behind a breakdown entry"
						: "find traces to drill into",
				),
			]
		}
		case "logs":
			return [
				doc.next(
					"search_logs",
					{ ...window, service: ctx.serviceName },
					"see individual log entries",
				),
			]
		case "metrics":
			return [
				doc.next(
					"explore_attributes",
					{ source: "metrics" },
					"discover attribute keys for filtering",
				),
			]
		case "product_events":
			return [doc.next("list_product_events", {}, "discover event names to filter by")]
	}
}

const renderQueryData = (output: Output): ToolDoc => {
	const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
	const title = `${capitalize(output.queryContext.source)} ${capitalize(output.kind)}: ${output.metric}`
	const scope: ToolDoc["scope"] = [
		["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
		["Grouped by", output.groupBy],
	]
	const decisions =
		output.decisions !== undefined && output.decisions.length > 0
			? [doc.heading("Defaults applied"), doc.list(output.decisions)]
			: []
	const next = nextCallsFor(output)

	if (output.result.kind === "timeseries") {
		const points = output.result.data
		if (points.length === 0) {
			return { title, scope, empty: { message: "No data points found." }, blocks: decisions, next }
		}
		const seriesKeys = [...new Set(points.flatMap((point) => Object.keys(point.series)))]
		if (seriesKeys.length === 0) seriesKeys.push("value")
		return {
			title,
			scope,
			blocks: [
				...decisions,
				doc.text(`Data points: ${formatNumber(points.length)}`),
				doc.table(
					["Bucket", ...seriesKeys],
					points.map((point) => [
						formatBucket(point.bucket),
						...seriesKeys.map((key) => formatMetricValue(output.metric, point.series[key] ?? 0)),
					]),
				),
			],
			next,
		}
	}

	const items = output.result.data
	if (items.length === 0) {
		return { title, scope, empty: { message: "No data found." }, blocks: decisions, next }
	}
	return {
		title,
		scope,
		blocks: [
			...decisions,
			doc.table(
				["Name", output.metric],
				items.map((item) => [item.name, formatMetricValue(output.metric, item.value)]),
			),
		],
		next,
	}
}

export function registerQueryDataTool(server: McpToolRegistrar) {
	server.define({
		name: "query_data",
		description: queryDataDescription,
		parameters: queryDataSchema,
		aliases: P.SERVICE_ALIASES,
		output: QueryDataOutput,
		hints: { readOnly: true },
		phrases: ["Querying telemetry", "Running a query", "Pulling the numbers"],
		handler: Effect.fn("McpTool.queryData")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, "query_data")

			if (params.attribute_value !== undefined && params.attribute_key === undefined) {
				return yield* new McpInvalidInputError({
					message:
						"`attribute_value` requires `attribute_key`. Use explore_attributes to discover available keys.",
					parameter: "attribute_key",
					example: 'attribute_key="http.method" attribute_value="GET"',
				})
			}

			if (params.group_by === "attribute" && params.attribute_key === undefined) {
				return yield* new McpInvalidInputError({
					message:
						"`group_by=attribute` requires `attribute_key`. Use explore_attributes to discover available keys.",
					parameter: "attribute_key",
					example: 'group_by="attribute" attribute_key="http.method"',
				})
			}

			if (
				params.source === "metrics" &&
				(params.metric_name === undefined || params.metric_type === undefined)
			) {
				return yield* new McpInvalidInputError({
					message:
						"`source=metrics` requires `metric_name` and `metric_type`. Use list_metrics to discover available metrics.",
					parameter: params.metric_name === undefined ? "metric_name" : "metric_type",
					example:
						'source="metrics" metric_name="http.server.duration" metric_type="histogram" metric="avg"',
				})
			}

			// Reject an out-of-vocabulary metric/group_by HERE, while we still know which source and
			// kind were asked for. Downstream, `QuerySpec` rejects the same value as an opaque
			// SchemaError that names neither the combination nor the alternatives.
			const badToken = describeInvalidQuerySpec({
				source: params.source,
				kind: params.kind,
				metric: params.metric,
				groupBy: params.group_by,
			})
			if (badToken !== undefined) {
				return yield* new McpInvalidInputError({
					message: badToken.message,
					parameter:
						params.metric !== undefined &&
						!tokensFor(params.source, params.kind).metrics.includes(params.metric)
							? "metric"
							: "group_by",
					example: badToken.example,
				})
			}

			const [defaultMetric, availableMetrics] = DEFAULT_METRIC[params.source]
			const [defaultGroupBy, availableGroupBys] = DEFAULT_GROUP_BY[params.source][params.kind]
			const metric = params.metric ?? defaultMetric
			const groupBy = params.group_by ?? defaultGroupBy

			const decisions: Array<string> = []
			if (params.start_time === undefined)
				decisions.push(`start_time: defaulted to 6 hours before end_time (${st})`)
			if (params.end_time === undefined) decisions.push(`end_time: defaulted to now (${et})`)
			if (params.metric === undefined) {
				decisions.push(
					params.source === "logs"
						? `metric: fixed to "count" (only option for logs)`
						: `metric: defaulted to "${defaultMetric}" (available: ${availableMetrics})`,
				)
			}
			if (params.group_by === undefined) {
				decisions.push(`group_by: defaulted to "${defaultGroupBy}" (available: ${availableGroupBys})`)
			}

			const query = yield* decodeQuerySpec(buildRawSpec(params, metric, groupBy)).pipe(
				Effect.mapError(
					(error) =>
						new McpInvalidInputError({
							message: `Invalid query specification: ${error.message}`,
						}),
				),
			)

			const tenant = yield* CurrentMcpTenant
			const queryEngine = yield* QueryEngineService

			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				source: params.source,
				kind: params.kind,
			})

			const response = yield* queryEngine.execute(tenant, { startTime: st, endTime: et, query }).pipe(
				Effect.catchTags({
					"@maple/http/errors/QueryEngineValidationError": (error) =>
						Effect.fail(
							new McpInvalidInputError({
								message:
									error.details.length > 0
										? `${error.message}\n${error.details.join("\n")}`
										: error.message,
							}),
						),
					"@maple/http/errors/QueryEngineTimeoutError": () =>
						Effect.fail(
							new McpQueryBudgetError({
								message:
									"The query ran past its time limit. Narrow start_time/end_time, add filters, or use a coarser bucket_seconds.",
								pipeName: "query_data",
								setting: "max_execution_time",
							}),
						),
					// Shared exact warehouse table; the mapping appends the schema-apply hint for drift.
					...warehouseReadToMcpHandlers("query_data"),
				}),
			)

			const result = response.result
			const resolved: Output["result"] | undefined =
				result.kind === "timeseries"
					? {
							kind: "timeseries",
							data: result.data.map((point) => ({
								bucket: point.bucket,
								series: { ...point.series },
							})),
						}
					: result.kind === "breakdown"
						? {
								kind: "breakdown",
								data: result.data.map((item) => ({ name: item.name, value: item.value })),
							}
						: undefined
			if (resolved === undefined) {
				return yield* new McpQueryError({
					message: `The query engine returned a "${result.kind}" result for a ${params.kind} query.`,
					pipeName: "query_data",
				})
			}

			const queryContext = queryContextOf(params)
			return {
				timeRange: { start: st, end: et },
				kind: params.kind,
				metric,
				...(params.group_by === undefined ? undefined : { groupBy: params.group_by }),
				...(decisions.length > 0 ? { decisions } : undefined),
				queryContext,
				unit: inferQueryDataUnit(params.source, metric, queryContext.metricName),
				result: resolved,
			}
		}),
		render: renderQueryData,
	})
}
