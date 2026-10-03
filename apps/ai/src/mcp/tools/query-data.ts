import { McpInvalidInputError, McpQueryBudgetError, McpQueryError, type McpToolRegistrar } from "./types"
import { describeInvalidQuerySpec, tokensFor } from "../lib/query-spec-tokens"
import { Effect, Schema } from "effect"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { QueryEngineService } from "@maple/backend/services/warehouse/QueryEngineService"
import { MetricType, QuerySpec } from "@maple/query-engine"
import { describeQuerySpecDecodeError } from "@maple/domain/query-engine"
import { ProductEventKind } from "@maple/domain/query-engine"
import { QueryDataOutput } from "@maple/domain/mcp-outputs"
import {
	bucketLabels,
	formatMetricValue,
	inferQueryDataUnit,
	PARTIAL_BUCKET_NOTE,
} from "../lib/format-query-result"
import { warehouseReadToMcpHandlers } from "../lib/map-warehouse-error"
import { formatNumber } from "../lib/format"
import * as P from "../lib/params"
import { LOG_SEVERITIES } from "./search-logs"
import { doc, type NextCall, type ToolDoc } from "../lib/tool-doc"
import { QUERY_BUILDER_DATA_SOURCES, type QueryResultContract } from "@maple/query-model"
import { resolveAttributeScope } from "../lib/attribute-scope"
import { emptyResultHints } from "../lib/empty-result-hints"

const WINDOW = P.timeWindow({ defaultHours: 6 })
const ATTRIBUTE_SCOPES = ["span", "resource"] as const
type AttributeScope = (typeof ATTRIBUTE_SCOPES)[number]

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
			"Metrics: avg, sum, min, max, count, rate, increase. For counters (sum metrics, Prometheus *_total " +
			"gauges) use increase (total over the window) or rate (per second); both are per-series and " +
			"reset-aware. sum adds raw samples. Default: count, or avg for metrics.",
	),
	group_by: P.optionalText(
		"Traces: service, span_name, status_code, http_method, attribute, resource_attribute. Logs: service, severity. " +
			"Metrics: service, attribute, resource_attribute. " +
			"Product events: event_name, kind, source, host, page_path, service, group, attribute. " +
			"'attribute' and 'resource_attribute' need attribute_key (resource_attribute reads resource keys such as " +
			"k8s.pod.name or deployment.environment). Timeseries also take 'none' (the default); breakdown defaults to service.",
	),
	...WINDOW.fields,
	service: P.service(),
	// Traces-specific
	span_name: P.optionalText(
		"Filter by span name (traces only). Exact match first; when nothing matches exactly it is matched as a case-insensitive substring",
	),
	root_spans_only: P.optionalFlag("Only include root spans (traces only)"),
	environments: P.optionalList(
		"Only these deployment environments (traces, logs, metrics; explore_attributes source=services lists them)",
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
	attribute_key: P.optionalText(
		"Attribute to filter on, or to group by with group_by=attribute. Span (or log/metric label) and resource attributes both work; the scope is resolved automatically",
	),
	attribute_value: P.optionalText("Exact value for attribute_key. Also applies when grouping by the same key"),
	attribute_scope: P.optionalOneOf(
		ATTRIBUTE_SCOPES,
		"Where attribute_key lives: 'span' (span, log or metric-datapoint attributes) or 'resource' (deployment.environment, k8s.pod.name...). Resolved from the known keys when omitted",
	),
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
		timeseries: ["none", "service, attribute, resource_attribute, none"],
		breakdown: ["service", "service, attribute, resource_attribute"],
	},
} as const

/** No rows, or a timeseries whose every value is zero: the filters matched nothing. */
export const isEmptyResult = (result: Output["result"]): boolean =>
	result.kind === "breakdown"
		? result.data.length === 0
		: result.data.every((point) => Object.values(point.series).every((value) => value === 0))

/** How the handler resolved the request before building the spec. */
export interface ResolvedQuery {
	readonly metric: string
	/** The query-engine group-by token (`resource_attribute` on traces becomes `attribute`). */
	readonly groupBy: string
	readonly attributeScope: AttributeScope
	readonly spanNameContains?: boolean
}

const groupsByAttribute = (params: Params) =>
	params.group_by === "attribute" || params.group_by === "resource_attribute"

/**
 * The attribute predicate. Grouping by the key without a value adds no "exists"
 * filter (spans without it stay in the "all" group); a value always filters.
 */
const attributeFilterOf = (params: Params) =>
	params.attribute_key === undefined || (groupsByAttribute(params) && params.attribute_value === undefined)
		? undefined
		: {
				key: params.attribute_key,
				...(params.attribute_value === undefined
					? { mode: "exists" }
					: { value: params.attribute_value, mode: "equals" }),
			}

/** `{ attributeFilters }` or `{ resourceAttributeFilters }` for the resolved scope. */
const scopedAttributeFilters = (params: Params, scope: AttributeScope) => {
	const filter = attributeFilterOf(params)
	if (filter === undefined) return undefined
	return scope === "resource" ? { resourceAttributeFilters: [filter] } : { attributeFilters: [filter] }
}

const environmentsOf = (params: Params) =>
	params.environments && params.environments.length > 0 ? { environments: params.environments } : undefined

/**
 * The query as plain data. It is decoded against `QuerySpec` afterwards, which checks every
 * token and brand, so this stays free of casts.
 */
export const buildRawSpec = (params: Params, resolved: ResolvedQuery): Record<string, unknown> => {
	const { metric, groupBy, attributeScope } = resolved
	const groupKey = groupsByAttribute(params) ? params.attribute_key : undefined
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
				...(params.span_name && resolved.spanNameContains && { matchModes: { spanName: "contains" } }),
				...(params.root_spans_only && { rootSpansOnly: true }),
				...environmentsOf(params),
				...(params.commit_shas &&
					params.commit_shas.length > 0 && { commitShas: params.commit_shas }),
				...(groupKey !== undefined &&
					(attributeScope === "resource"
						? { groupByResourceAttributeKey: groupKey }
						: { groupByAttributeKeys: [groupKey] })),
				...scopedAttributeFilters(params, attributeScope),
				...(params.apdex_threshold_ms && { apdexThresholdMs: params.apdex_threshold_ms }),
			})
		case "logs":
			return withFilters({
				...(params.service && { serviceName: params.service }),
				...(params.severity && { severity: params.severity }),
				...environmentsOf(params),
				...scopedAttributeFilters(params, attributeScope),
			})
		case "product_events":
			return withFilters({
				...(params.event_name && params.event_name.length > 0 && { eventNames: params.event_name }),
				...(params.event_kind && params.event_kind.length > 0 && { kinds: params.event_kind }),
				...(params.host && { hosts: [params.host] }),
				...(params.page_path && { pagePaths: [params.page_path] }),
				...(params.service && { serviceNames: [params.service] }),
				...(groupKey !== undefined && { groupByAttributeKey: groupKey }),
				...(attributeFilterOf(params) !== undefined && { attributeFilters: [attributeFilterOf(params)] }),
			})
		case "metrics":
			return {
				...queryFields,
				filters: {
					metricName: params.metric_name,
					metricType: params.metric_type,
					...(params.service && { serviceName: params.service }),
					...environmentsOf(params),
					...(groupKey !== undefined &&
						(attributeScope === "resource"
							? { groupByResourceAttributeKey: groupKey }
							: { groupByAttributeKey: groupKey })),
					...scopedAttributeFilters(params, attributeScope),
				},
			}
	}
}

// Counter names that arrive as gauges from Prometheus-style exporters.
const COUNTER_NAME = /(_total|_count|_sum|_bucket)$/

/** Caveats on numbers that are easy to misread, rendered above the result. */
const metricsWarningsFor = (params: Params, metric: string): Array<string> => {
	if (params.source !== "metrics") return []
	const warnings: Array<string> = []
	const looksLikeCounter =
		params.metric_type === "sum" ||
		(params.metric_type === "gauge" && COUNTER_NAME.test(params.metric_name ?? ""))
	if (metric === "sum" && looksLikeCounter) {
		warnings.push(
			"metric=sum adds raw samples. On a cumulative counter (most OTel and Prometheus counters) that " +
				"totals running counts and is not a real figure; use metric=increase for the total over the " +
				"window or metric=rate for per-second throughput. sum is right only for delta-temporality counters.",
		)
	}
	const additive = metric === "sum" || metric === "rate" || metric === "increase"
	const splitsByEnv =
		(params.environments !== undefined && params.environments.length > 0) ||
		params.group_by === "resource_attribute"
	if (additive && !splitsByEnv) {
		warnings.push(
			"No environments filter: series from every deployment environment are added together. Pass " +
				"environments, or group_by=resource_attribute attribute_key=deployment.environment to split them.",
		)
	}
	return warnings
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
					{ source: "metrics", metric_name: ctx.metricName, service: ctx.serviceName },
					"discover this metric's attribute keys for filtering or grouping",
				),
			]
		case "product_events":
			return [doc.next("list_product_events", {}, "discover event names to filter by")]
	}
}

const isWeightedCount = (output: Output) => output.queryContext.source === "traces" && output.metric === "count"

/** Trace counts are sample-weighted; latencies are not (tail sampling skews them). */
const samplingNote = (output: Output): string | undefined => {
	if (output.queryContext.source !== "traces") return undefined
	if (output.metric === "count")
		return "count is an estimate of spans that happened, weighted by each span's sample rate and rounded; it is not the number of stored spans."
	if (output.metric.includes("duration"))
		return "Durations are computed over the stored spans without sample-rate weighting; under tail sampling they lean toward the kept (slow or failed) spans."
	return undefined
}

export const renderQueryData = (output: Output): ToolDoc => {
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
	if (output.warnings !== undefined && output.warnings.length > 0) {
		decisions.unshift(doc.heading("Warnings"), doc.list(output.warnings))
	}
	const hints = output.emptyHints ?? []
	const notes = [
		...(samplingNote(output) === undefined ? [] : [doc.text(samplingNote(output) ?? "")]),
		...(hints.length > 0 ? [doc.heading("Why this may be empty"), doc.list(hints)] : []),
	]
	const emptyWith = (message: string) => ({ message, ...(hints.length > 0 ? { hints } : undefined) })

	if (output.result.kind === "timeseries") {
		const points = output.result.data
		if (points.length === 0) {
			return { title, scope, empty: emptyWith("No data points found."), blocks: decisions, next }
		}
		const seriesKeys = [...new Set(points.flatMap((point) => Object.keys(point.series)))]
		if (seriesKeys.length === 0) seriesKeys.push("value")
		const { labels, lastIsPartial } = bucketLabels(
			points.map((point) => point.bucket),
			output.timeRange.end,
			output.queryContext.bucketSeconds,
		)
		// A bucket with no rows has no value: printing 0 there reads as a measured all-clear.
		const cell = (value: number | undefined) =>
			value === undefined ? "-" : formatMetricValue(output.metric, value)
		const hasGaps = points.some((point) => seriesKeys.some((key) => point.series[key] === undefined))
		return {
			title,
			scope,
			blocks: [
				...decisions,
				doc.text(`Data points: ${formatNumber(points.length)}`),
				doc.table(
					["Bucket", ...seriesKeys],
					points.map((point, i) => [
						labels[i] ?? point.bucket,
						...seriesKeys.map((key) => cell(point.series[key])),
					]),
				),
				...(hasGaps ? [doc.text("`-`: no rows in that bucket (no data, not a measured 0).")] : []),
				...(lastIsPartial ? [doc.text(PARTIAL_BUCKET_NOTE)] : []),
				...notes,
			],
			next,
		}
	}

	const items = output.result.data
	if (items.length === 0) {
		return { title, scope, empty: emptyWith("No data found."), blocks: decisions, next }
	}
	return {
		title,
		scope,
		blocks: [
			...decisions,
			doc.table(
				["Name", isWeightedCount(output) ? "count (estimated)" : output.metric],
				items.map((item) => [item.name, formatMetricValue(output.metric, item.value)]),
			),
			...notes,
		],
		next,
	}
}

export function registerQueryDataTool(server: McpToolRegistrar) {
	server.define({
		name: "query_data",
		title: "Query Data",
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

			if (groupsByAttribute(params) && params.attribute_key === undefined) {
				return yield* new McpInvalidInputError({
					message: `\`group_by=${params.group_by}\` requires \`attribute_key\`. Use explore_attributes to discover available keys.`,
					parameter: "attribute_key",
					example:
						params.group_by === "attribute"
							? 'group_by="attribute" attribute_key="http.method"'
							: 'group_by="resource_attribute" attribute_key="k8s.pod.name"',
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
			// Traces have no resource_attribute token: it is group_by=attribute on the resource map.
			const requestedGroupBy =
				params.source === "traces" && params.group_by === "resource_attribute"
					? "attribute"
					: params.group_by
			const badToken = describeInvalidQuerySpec({
				source: params.source,
				kind: params.kind,
				metric: params.metric,
				groupBy: requestedGroupBy,
			})
			if (badToken !== undefined) {
				const percentileNote =
					params.source === "metrics" && /^p\d+/.test(params.metric ?? "")
						? " Metric percentiles are not supported: use avg, or source=traces metric=p95_duration for request latency."
						: ""
				return yield* new McpInvalidInputError({
					message: badToken.message + percentileNote,
					parameter:
						params.metric !== undefined &&
						!tokensFor(params.source, params.kind).metrics.includes(params.metric)
							? "metric"
							: "group_by",
					example: badToken.example,
				})
			}

			const isHistogram =
				params.metric_type === "histogram" || params.metric_type === "exponential_histogram"
			if (
				params.source === "metrics" &&
				isHistogram &&
				(params.metric === "rate" || params.metric === "increase")
			) {
				return yield* new McpInvalidInputError({
					message: `metric=${params.metric} needs a counter (metric_type sum or gauge). For a histogram use count (observations per bucket) or avg.`,
					parameter: "metric",
					example: `source="metrics" metric_name="${params.metric_name ?? "http.server.duration"}" metric_type="histogram" metric="count"`,
				})
			}

			const [defaultMetric, availableMetrics] = DEFAULT_METRIC[params.source]
			const [defaultGroupBy, availableGroupBys] = DEFAULT_GROUP_BY[params.source][params.kind]
			const metric = params.metric ?? defaultMetric

			const decisions: Array<string> = []
			if (params.start_time === undefined)
				decisions.push(
					`start_time: defaulted to ${WINDOW.spec.defaultHours} hours before end_time (${st})`,
				)
			if (params.end_time === undefined) decisions.push(`end_time: defaulted to now (${et})`)
			// Defaults that cannot change the answer (logs' only metric, no grouping) are not noted.
			if (params.metric === undefined && params.source !== "logs") {
				decisions.push(`metric: defaulted to "${defaultMetric}" (available: ${availableMetrics})`)
			}
			if (params.group_by === undefined && defaultGroupBy !== "none") {
				decisions.push(`group_by: defaulted to "${defaultGroupBy}" (available: ${availableGroupBys})`)
			}

			const attributeScope = yield* resolveAttributeScope(params, { startTime: st, endTime: et })
			if (attributeScope.decision !== undefined) decisions.push(attributeScope.decision)
			const scope = attributeScope.scope
			const baseGroupBy = requestedGroupBy ?? defaultGroupBy
			const groupBy =
				params.source === "metrics" && baseGroupBy === "attribute" && scope === "resource"
					? "resource_attribute"
					: baseGroupBy

			const tenant = yield* CurrentMcpTenant
			const queryEngine = yield* QueryEngineService
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				source: params.source,
				kind: params.kind,
			})

			const run = Effect.fn("McpTool.queryData.run")(function* (resolved: ResolvedQuery) {
				const rawSpec = buildRawSpec(params, resolved)
				const query = yield* decodeQuerySpec(rawSpec).pipe(
					Effect.mapError(
						(error) =>
							new McpInvalidInputError({
								message: describeQuerySpecDecodeError(rawSpec, error.message),
							}),
					),
				)
				const response = yield* queryEngine
					.execute(tenant, { startTime: st, endTime: et, query })
					.pipe(
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
				const mapped: Output["result"] | undefined =
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
				if (mapped === undefined) {
					return yield* new McpQueryError({
						message: `The query engine returned a "${result.kind}" result for a ${params.kind} query.`,
						pipeName: "query_data",
					})
				}
				return mapped
			})

			const resolvedQuery: ResolvedQuery = { metric, groupBy, attributeScope: scope }
			let resolved = yield* run(resolvedQuery)
			// Exact span names are easy to miss (`resetAudienceAssignments` vs the real
			// `CampaignsV2Handler.resetAudienceAssignments`): retry as a substring, like search_traces.
			if (params.source === "traces" && params.span_name !== undefined && isEmptyResult(resolved)) {
				resolved = yield* run({ ...resolvedQuery, spanNameContains: true })
				decisions.push(
					`span_name: no span is named exactly "${params.span_name}"; matched as a case-insensitive substring instead`,
				)
			}

			const emptyHints = isEmptyResult(resolved)
				? yield* emptyResultHints(
						{
							service: params.service,
							environments: params.source === "product_events" ? undefined : params.environments,
							attributeKey: params.source === "product_events" ? undefined : params.attribute_key,
							spanName: params.source === "traces" ? params.span_name : undefined,
						},
						{ startTime: st, endTime: et },
						{ traceKeys: params.source === "traces" || params.source === "logs" },
					)
				: []

			const queryContext = queryContextOf(params)
			const warnings = metricsWarningsFor(params, metric)
			return {
				timeRange: { start: st, end: et },
				kind: params.kind,
				metric,
				...(params.group_by === undefined ? undefined : { groupBy: params.group_by }),
				...(decisions.length > 0 ? { decisions } : undefined),
				...(warnings.length > 0 ? { warnings } : undefined),
				queryContext,
				unit: inferQueryDataUnit(params.source, metric, queryContext.metricName),
				result: resolved,
				...(emptyHints.length > 0 ? { emptyHints } : undefined),
			}
		}),
		render: renderQueryData,
	})
}
