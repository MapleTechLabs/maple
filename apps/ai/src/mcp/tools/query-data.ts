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
import { doc, type NextCall, type ToolDoc } from "../lib/tool-doc"
import { QUERY_BUILDER_DATA_SOURCES, type QueryResultContract } from "@maple/query-model"

const WINDOW = P.timeWindow({ defaultHours: 6 })

const isProductEventKind = Schema.is(ProductEventKind)
const decodeQuerySpec = Schema.decodeUnknownEffect(QuerySpec)

type Output = typeof QueryDataOutput.Type

const queryDataSchema = Schema.Struct({
	source: P.oneOf(
		QUERY_BUILDER_DATA_SOURCES,
		"Data source. Use 'traces' for request/span analysis (latency, errors, throughput). " +
			"Use 'logs' for log volume analysis. " +
			"Use 'metrics' for custom metric aggregation (requires metric_name and metric_type; call list_metrics first). " +
			"Use 'product_events' for product analytics: track() events, page views and server events (call list_product_events to discover names).",
	),
	kind: P.oneOf(
		["timeseries", "breakdown"] as const satisfies ReadonlyArray<QueryResultContract>,
		"Query shape. Use 'timeseries' when the user asks about trends, patterns, or 'how has X changed over time'. " +
			"Use 'breakdown' when asking about top-N, distribution, or 'which services have the most errors'. " +
			"Pick the right kind first: do not call this tool twice for the same question.",
	),
	metric: P.optionalText(
		"Metric to compute. Traces: count (request volume), avg_duration, p50_duration, p95_duration, p99_duration (latency), " +
			"error_rate (0-1 ratio), apdex (user satisfaction, requires apdex_threshold_ms). Logs: count only. " +
			"Product events: count, sessions, persons, users, visitors (distinct sessions / people / identified users / anonymous visitors). " +
			"Metrics with kind=timeseries: avg, sum, min, max, count, rate, increase; with kind=breakdown ONLY avg, sum, count. " +
			"For monotonic counters (typically metric_type=sum with isMonotonic=true from list_metrics), prefer rate or increase over raw sum. " +
			"Default: 'count' for traces/logs, 'avg' for metrics.",
	),
	group_by: P.optionalText(
		"Grouping dimension. Traces: service, span_name, status_code, http_method, attribute. " +
			"Logs: service, severity. Metrics: service, attribute, resource_attribute. " +
			"Product events: event_name, kind, source, host, page_path, service, group, attribute. " +
			"'none' is additionally valid for kind=timeseries but not for kind=breakdown. " +
			"Default: 'none' for timeseries, 'service' for breakdown.",
	),
	...WINDOW.fields,
	service: P.service("Only this service (exact `service.name`; use list_services to discover)"),
	// Traces-specific
	span_name: P.optionalText("Filter by span name (traces only)"),
	root_spans_only: P.optionalFlag("Only include root spans (traces only)"),
	environments: P.optionalList(
		"Environments to filter (traces only, use explore_attributes source=services to discover)",
	),
	commit_shas: P.optionalList("Commit SHAs to filter (traces only)"),
	apdex_threshold_ms: P.optionalNumber(
		"Apdex threshold in milliseconds (traces only, required for apdex metric)",
	),
	// Logs-specific
	severity: P.optionalText("Filter by log severity: TRACE, DEBUG, INFO, WARN, ERROR, FATAL (logs only)"),
	// Product-events-specific
	event_name: P.optionalList(
		"Filter by event name, several allowed (product_events only, use list_product_events to discover)",
	),
	event_kind: P.optionalList("Filter by event kind: navigation, custom or screen (product_events only)"),
	host: P.optionalText("Filter by the site host the event fired on (product_events only)"),
	page_path: P.optionalText("Filter by the page path the event fired on (product_events only)"),
	// Metrics-specific
	metric_name: P.optionalText(
		"Metric name, required for source=metrics. Use list_metrics to discover available metrics.",
	),
	metric_type: P.optionalOneOf(MetricType.literals, "Metric type, required for source=metrics"),
	// Shared attribute filtering
	attribute_key: P.optionalText(
		"Attribute key for filtering or group_by=attribute. Use explore_attributes to discover keys.",
	),
	attribute_value: P.optionalText("Attribute value filter (requires attribute_key)"),
	bucket_seconds: P.optionalNumber("Bucket size in seconds (timeseries only, auto-computed if omitted)"),
	limit: P.limit({ default: 10, max: 100, noun: "breakdown rows (breakdown only)" }),
})

type Params = typeof queryDataSchema.Type

const queryDataDescription =
	"Query timeseries or breakdown data from traces, logs, metrics, or product events. " +
	"Start here for trend analysis, comparisons, and top-N queries. " +
	"For error investigation, prefer find_errors and error_detail. " +
	"For attribute discovery, call explore_attributes first. " +
	"Defaults are applied automatically and shown in the response."

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

			if (params.source === "product_events" && params.event_kind !== undefined) {
				const bad = params.event_kind.find((kind) => !isProductEventKind(kind))
				if (bad !== undefined) {
					return yield* new McpInvalidInputError({
						message: `\`event_kind\` must be navigation, custom or screen (got "${bad}").`,
						parameter: "event_kind",
						example: 'source="product_events" event_kind="custom"',
					})
				}
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
