import { Effect, Schema } from "effect"
import { IngestUsageOutput } from "@maple/domain/mcp-outputs"
import { CH } from "@maple/query-engine"
import { WarehouseExecutor } from "@maple/query-engine/observability"
import type { McpToolRegistrar } from "./types"
import { warehouseToMcpHandlers } from "../lib/map-warehouse-error"
import { withTenantExecutor, CurrentMcpTenant } from "../lib/query-warehouse"
import { formatNumber } from "../lib/format"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const TOOL = "ingest_usage"
/** `service_usage` keeps a year of hourly rows. */
const WINDOW = P.timeWindow({ defaultHours: 7 * 24, maxHours: 365 * 24 })

type UsageRow = typeof IngestUsageOutput.Type.totals

const formatBytes = (bytes: number): string => {
	const units = ["B", "KB", "MB", "GB", "TB"]
	let value = bytes
	let unit = 0
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024
		unit += 1
	}
	return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
}

const toUsageRow = (row: CH.ServiceUsageOutput): UsageRow => ({
	service: row.serviceName,
	traceCount: row.totalTraceCount,
	logCount: row.totalLogCount,
	metricCount:
		row.totalSumMetricCount +
		row.totalGaugeMetricCount +
		row.totalHistogramMetricCount +
		row.totalExpHistogramMetricCount,
	traceBytes: row.totalTraceSizeBytes,
	logBytes: row.totalLogSizeBytes,
	metricBytes:
		row.totalSumMetricSizeBytes +
		row.totalGaugeMetricSizeBytes +
		row.totalHistogramMetricSizeBytes +
		row.totalExpHistogramMetricSizeBytes,
	totalBytes: row.totalSizeBytes,
})

const sumRows = (rows: ReadonlyArray<UsageRow>): UsageRow =>
	rows.reduce(
		(acc, row) => ({
			service: acc.service,
			traceCount: acc.traceCount + row.traceCount,
			logCount: acc.logCount + row.logCount,
			metricCount: acc.metricCount + row.metricCount,
			traceBytes: acc.traceBytes + row.traceBytes,
			logBytes: acc.logBytes + row.logBytes,
			metricBytes: acc.metricBytes + row.metricBytes,
			totalBytes: acc.totalBytes + row.totalBytes,
		}),
		{
			service: "(all)",
			traceCount: 0,
			logCount: 0,
			metricCount: 0,
			traceBytes: 0,
			logBytes: 0,
			metricBytes: 0,
			totalBytes: 0,
		},
	)

export function registerIngestUsageTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "Ingest Usage",
		description:
			"Telemetry ingested per service over the window: span, log record and metric datapoint counts with their sizes, plus org totals, largest services first. Read from the hourly usage rollup (summed on merge, so totals are exact), so a window up to a year is cheap. Both ends widen to whole hours. Use it for volume or cost questions instead of counting rows with run_sql.",
		parameters: Schema.Struct({
			...WINDOW.fields,
			service: P.service(),
		}),
		aliases: P.SERVICE_ALIASES,
		output: IngestUsageOutput,
		hints: { readOnly: true },
		phrases: ["Measuring ingest volume"],
		handler: Effect.fn("McpTool.ingestUsage")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, TOOL)
			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, service: params.service ?? "all" })

			const rows = yield* withTenantExecutor(
				Effect.gen(function* () {
					const executor = yield* WarehouseExecutor
					const compiled = CH.compile(
						CH.serviceUsageQuery({ serviceName: params.service }),
						{ orgId: executor.orgId, startTime: st, endTime: et },
						{ rowSchema: CH.serviceUsageRowSchema },
					)
					return yield* executor.compiledQuery(compiled, {
						profile: "aggregation",
						context: "ingestUsage",
					})
				}),
			).pipe(Effect.catchTags(warehouseToMcpHandlers(TOOL)))
			yield* Effect.annotateCurrentSpan("result.rowCount", rows.length)

			const services = rows.map(toUsageRow)
			return {
				timeRange: { start: st, end: et },
				...(params.service === undefined ? undefined : { service: params.service }),
				totals: sumRows(services),
				services,
			}
		}),
		render: (output) => {
			const { services, totals } = output
			const cells = (r: UsageRow) => [
				r.service,
				formatNumber(r.traceCount),
				formatNumber(r.logCount),
				formatNumber(r.metricCount),
				formatBytes(r.totalBytes),
			]
			return {
				title: "Ingest Usage",
				scope: [
					["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
					["Service", output.service],
				],
				...(services.length === 0
					? {
							empty: {
								message: "Nothing was ingested in this window.",
								hints: ["Widen start_time/end_time, or check ingest_freshness for a stall."],
							},
						}
					: undefined),
				blocks:
					services.length === 0
						? []
						: [
								doc.table(
									["Service", "Spans", "Log records", "Metric datapoints", "Size"],
									[...services.map(cells), ...(services.length > 1 ? [cells(totals)] : [])],
								),
							],
				next: [doc.next("ingest_freshness", {}, "check whether data is still arriving")],
			}
		},
	})
}
