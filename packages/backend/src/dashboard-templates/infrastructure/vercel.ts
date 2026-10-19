import { escapeClickHouseString } from "@maple-dev/effect-orm/sql"
import { rawSqlDisplayTypeFor } from "@maple/widgets"
import { makeRawSqlDataSource } from "@maple/widgets/dashboard"
import {
	CHART_DISPLAY_AREA,
	CHART_DISPLAY_LINE,
	buildPortableDashboard,
	combineWhere,
	makeQueryBuilderTimeseriesDataSource,
	makeQueryDraft,
	paramKey,
	paramValue,
	serviceWhereClause,
	templateId,
} from "@maple/backend/dashboard-templates/helpers"
import type { TemplateDefinition, WidgetDef } from "@maple/backend/dashboard-templates/types"

// The log drain lands Vercel request, function, build and edge logs with resource
// `cloud.provider=vercel` and `service.name` = the project name; a request is a record with
// `http.request.method` set. The trace drain carries AI Gateway requests as server spans of service
// `ai-gateway` in namespace `vercel`. Log counts use the query builder; status classes, ratios, top-N
// tables and every AI Gateway widget are SQL, which the logs builder (no attribute group-by) and the
// traces builder (no span-kind filter, no attribute sums) cannot express.

const REQUESTS_WHERE = `resource.cloud.provider = "vercel" AND attr.http.request.method exists`

function logsSql(projectName?: string): string {
	const project = projectName ? ` AND ServiceName = '${escapeClickHouseString(projectName)}'` : ""
	return `$__orgFilter AND $__timeFilter(Timestamp) AND ResourceAttributes['cloud.provider'] = 'vercel'${project}`
}

const REQUEST_SQL = `LogAttributes['http.request.method'] != ''`
const STATUS_SQL = `toUInt16OrZero(LogAttributes['http.response.status_code'])`
const CACHE_SQL = `LogAttributes['vercel.cache']`
const CACHE_HIT_RATIO_SQL = `countIf(${CACHE_SQL} = 'HIT') / nullIf(countIf(${CACHE_SQL} != ''), 0)`

const GATEWAY_SQL = `$__orgFilter AND $__timeFilter(Timestamp) AND ServiceName = 'ai-gateway' AND SpanKind = 'Server' AND ResourceAttributes['service.namespace'] = 'vercel'`
const spanNumber = (key: string) => `sum(toFloat64OrZero(SpanAttributes['${key}']))`
/** USD only (an absent currency is USD), so the "$" on the widgets holds. */
const COST_SQL = `sumIf(toFloat64OrZero(SpanAttributes['vercel.ai_gateway.cost.total']), SpanAttributes['vercel.ai_gateway.cost.currency'] IN ('', 'USD'))`
const INPUT_TOKENS_SQL = spanNumber("gen_ai.usage.input_tokens")
const OUTPUT_TOKENS_SQL = spanNumber("gen_ai.usage.output_tokens")
const MODEL_SQL = `if(SpanAttributes['gen_ai.response.model'] != '', SpanAttributes['gen_ai.response.model'], SpanAttributes['gen_ai.request.model'])`

function sqlWidget(opts: {
	id: string
	visualization: "chart" | "stat" | "table"
	sql: string
	display: WidgetDef["display"]
	layout: WidgetDef["layout"]
}): WidgetDef {
	return {
		id: opts.id,
		visualization: opts.visualization,
		dataSource: makeRawSqlDataSource({
			sql: opts.sql,
			displayType: rawSqlDisplayTypeFor(opts.visualization, opts.display.chartId),
			// A stat reads `data[0].value`.
			...(opts.visualization === "stat" && {
				transform: { reduceToValue: { field: "value", aggregate: "first" } },
			}),
		}),
		display: opts.display,
		layout: opts.layout,
	}
}

function widgets(projectName?: string): WidgetDef[] {
	const requestsWhere = combineWhere(REQUESTS_WHERE, serviceWhereClause(projectName))
	const logs = logsSql(projectName)
	const requests = `${logs} AND ${REQUEST_SQL}`
	return [
		{
			id: "kpi-requests",
			visualization: "stat",
			dataSource: {
				...makeQueryBuilderTimeseriesDataSource([
					makeQueryDraft({
						id: "kpi-requests",
						name: "Requests",
						dataSource: "logs",
						aggregation: "count",
						whereClause: requestsWhere,
					}),
				]),
				transform: { reduceToValue: { field: "Requests", aggregate: "sum" } },
			},
			display: { title: "Requests", unit: "number" },
			layout: { x: 0, y: 0, w: 3, h: 2 },
		},
		sqlWidget({
			id: "kpi-cache-hit-rate",
			visualization: "stat",
			sql: `SELECT ${CACHE_HIT_RATIO_SQL} AS value FROM logs WHERE ${requests}`,
			display: { title: "Cache Hit Rate", unit: "percent" },
			layout: { x: 3, y: 0, w: 3, h: 2 },
		}),
		sqlWidget({
			id: "kpi-5xx-rate",
			visualization: "stat",
			sql: `SELECT countIf(${STATUS_SQL} >= 500) / nullIf(count(), 0) AS value FROM logs WHERE ${requests}`,
			display: { title: "5xx Rate", unit: "percent" },
			layout: { x: 6, y: 0, w: 3, h: 2 },
		}),
		sqlWidget({
			id: "kpi-error-logs",
			visualization: "stat",
			sql: `SELECT count() AS value FROM logs WHERE ${logs} AND SeverityNumber >= 17`,
			display: { title: "Error Logs", unit: "number" },
			layout: { x: 9, y: 0, w: 3, h: 2 },
		}),

		{
			id: "requests-by-project",
			visualization: "chart",
			dataSource: makeQueryBuilderTimeseriesDataSource([
				makeQueryDraft({
					id: "vercel-requests",
					name: "Requests",
					dataSource: "logs",
					aggregation: "count",
					whereClause: requestsWhere,
					groupBy: ["service.name"],
				}),
			]),
			display: { title: "Requests by Project", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 0, y: 2, w: 6, h: 6 },
		},
		sqlWidget({
			id: "requests-by-status",
			visualization: "chart",
			sql: `SELECT $__timeGroup(Timestamp) AS bucket, ${[2, 3, 4, 5]
				.map((digit) => `countIf(intDiv(${STATUS_SQL}, 100) = ${digit}) AS \`${digit}xx\``)
				.join(", ")} FROM logs WHERE ${requests} GROUP BY bucket ORDER BY bucket`,
			display: { title: "Requests by Status Class", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 6, y: 2, w: 6, h: 6 },
		}),
		sqlWidget({
			id: "cache-hit-rate",
			visualization: "chart",
			sql: `SELECT $__timeGroup(Timestamp) AS bucket, ${CACHE_HIT_RATIO_SQL} AS hit_rate FROM logs WHERE ${requests} GROUP BY bucket ORDER BY bucket`,
			display: { title: "Cache Hit Rate", ...CHART_DISPLAY_LINE, unit: "percent" },
			layout: { x: 0, y: 8, w: 6, h: 6 },
		}),
		sqlWidget({
			id: "top-paths",
			visualization: "table",
			sql: `SELECT LogAttributes['url.path'] AS path, count() AS requests, countIf(${STATUS_SQL} >= 500) AS errors_5xx FROM logs WHERE ${requests} GROUP BY path ORDER BY requests DESC LIMIT 20`,
			display: {
				title: "Top Paths",
				columns: [
					{ field: "path", header: "Path" },
					{ field: "requests", header: "Requests", unit: "number", align: "right" },
					{ field: "errors_5xx", header: "5xx", unit: "number", align: "right" },
				],
			},
			layout: { x: 6, y: 8, w: 6, h: 6 },
		}),
		sqlWidget({
			id: "error-logs",
			visualization: "table",
			sql: `SELECT ServiceName AS project, substring(Body, 1, 300) AS message, count() AS count, max(Timestamp) AS last_seen FROM logs WHERE ${logs} AND SeverityNumber >= 17 GROUP BY project, message ORDER BY count DESC LIMIT 20`,
			display: {
				title: "Error Logs",
				columns: [
					{ field: "project", header: "Project" },
					{ field: "message", header: "Message" },
					{ field: "count", header: "Count", unit: "number", align: "right" },
					{ field: "last_seen", header: "Last Seen" },
				],
			},
			layout: { x: 0, y: 14, w: 12, h: 6 },
		}),

		sqlWidget({
			id: "kpi-gateway-spend",
			visualization: "stat",
			sql: `SELECT ${COST_SQL} AS value FROM traces WHERE ${GATEWAY_SQL}`,
			display: { title: "AI Gateway Spend (USD)", unit: "number" },
			layout: { x: 0, y: 20, w: 3, h: 2 },
		}),
		sqlWidget({
			id: "kpi-gateway-requests",
			visualization: "stat",
			sql: `SELECT count() AS value FROM traces WHERE ${GATEWAY_SQL}`,
			display: { title: "AI Gateway Requests", unit: "number" },
			layout: { x: 3, y: 20, w: 3, h: 2 },
		}),
		sqlWidget({
			id: "kpi-gateway-input-tokens",
			visualization: "stat",
			sql: `SELECT ${INPUT_TOKENS_SQL} AS value FROM traces WHERE ${GATEWAY_SQL}`,
			display: { title: "Input Tokens", unit: "number" },
			layout: { x: 6, y: 20, w: 3, h: 2 },
		}),
		sqlWidget({
			id: "kpi-gateway-output-tokens",
			visualization: "stat",
			sql: `SELECT ${OUTPUT_TOKENS_SQL} AS value FROM traces WHERE ${GATEWAY_SQL}`,
			display: { title: "Output Tokens", unit: "number" },
			layout: { x: 9, y: 20, w: 3, h: 2 },
		}),

		sqlWidget({
			id: "gateway-spend",
			visualization: "chart",
			sql: `SELECT $__timeGroup(Timestamp) AS bucket, ${COST_SQL} AS spend_usd FROM traces WHERE ${GATEWAY_SQL} GROUP BY bucket ORDER BY bucket`,
			display: { title: "AI Gateway Spend (USD)", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 0, y: 22, w: 6, h: 6 },
		}),
		sqlWidget({
			id: "gateway-tokens",
			visualization: "chart",
			sql: `SELECT $__timeGroup(Timestamp) AS bucket, ${INPUT_TOKENS_SQL} AS input_tokens, ${OUTPUT_TOKENS_SQL} AS output_tokens FROM traces WHERE ${GATEWAY_SQL} GROUP BY bucket ORDER BY bucket`,
			display: { title: "AI Gateway Tokens", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 6, y: 22, w: 6, h: 6 },
		}),
		sqlWidget({
			id: "gateway-requests",
			visualization: "chart",
			sql: `SELECT $__timeGroup(Timestamp) AS bucket, count() AS requests, countIf(StatusCode = 'Error') AS errors FROM traces WHERE ${GATEWAY_SQL} GROUP BY bucket ORDER BY bucket`,
			display: { title: "AI Gateway Requests", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 0, y: 28, w: 6, h: 6 },
		}),
		sqlWidget({
			id: "gateway-by-model",
			visualization: "table",
			sql: `SELECT ${MODEL_SQL} AS model, count() AS requests, ${INPUT_TOKENS_SQL} AS input_tokens, ${OUTPUT_TOKENS_SQL} AS output_tokens, ${COST_SQL} AS spend_usd FROM traces WHERE ${GATEWAY_SQL} GROUP BY model ORDER BY spend_usd DESC, requests DESC LIMIT 20`,
			display: {
				title: "AI Gateway Usage by Model",
				columns: [
					{ field: "model", header: "Model" },
					{ field: "requests", header: "Requests", unit: "number", align: "right" },
					{ field: "input_tokens", header: "Input", unit: "number", align: "right" },
					{ field: "output_tokens", header: "Output", unit: "number", align: "right" },
					{ field: "spend_usd", header: "Spend (USD)", unit: "number", align: "right" },
				],
			},
			layout: { x: 6, y: 28, w: 6, h: 6 },
		}),
	]
}

export const vercelTemplate: TemplateDefinition = {
	id: templateId("vercel"),
	name: "Vercel",
	description:
		"Logs and traces from the Vercel integration: requests by project and status class, cache hit rate, 5xx rate, top paths and error logs, plus AI Gateway spend, requests, tokens and usage by model.",
	category: "infrastructure",
	tags: ["vercel", "ai gateway", "edge", "serverless"],
	// Logs and traces only, so never gated: the gate reads metric names.
	requirement: {
		kind: "telemetry",
		label: "Vercel integration connected with logs and traces forwarded",
		collector: "the Vercel integration's log and trace drains",
	},
	parameters: [
		{
			key: paramKey("project_name"),
			label: "Project",
			description: "Optional. Scope the request and log widgets to one Vercel project.",
			required: false,
			placeholder: "my-app",
		},
	],
	build: (params) => {
		const projectName = paramValue(params, "project_name")
		return buildPortableDashboard({
			name: projectName ? `${projectName} — Vercel` : "Vercel",
			description: "Vercel requests, cache, errors and AI Gateway usage from the log and trace drains.",
			tags: ["vercel"],
			timeRange: "24h",
			widgets: widgets(projectName),
		})
	},
}
