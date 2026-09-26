// Table-mode renderers for the query commands' results. JSON output never
// passes through here; these only shape what `--format table` prints.

import type {
	ErrorDetailOutput,
	ErrorSummary,
	FindSlowTracesOutput,
	InspectTraceOutput,
	LogEntry,
	MineLogPatternsOutput,
	SearchLogsOutput,
	SearchTracesOutput,
	ServiceHealthOutput,
	ServiceSummary,
	SpanNode,
	SpanResult,
} from "@maple/query-engine/observability"
import {
	type Column,
	type Section,
	type View,
	formatCount,
	formatDecimal,
	formatDuration,
	formatPercent,
	formatTimestamp,
	renderFields,
	renderTable,
} from "./output"

const right = "right" as const

const logColumns: ReadonlyArray<Column<LogEntry>> = [
	{ header: "TIME", cell: (l) => formatTimestamp(l.timestamp) },
	{ header: "SEVERITY", cell: (l) => l.severityText },
	{ header: "SERVICE", cell: (l) => l.serviceName },
	{ header: "BODY", cell: (l) => l.body, maxWidth: 100 },
]

const spanColumns: ReadonlyArray<Column<SpanResult>> = [
	{ header: "TRACE ID", cell: (s) => s.traceId },
	{ header: "TIME", cell: (s) => formatTimestamp(s.timestamp) },
	{ header: "SERVICE", cell: (s) => s.serviceName },
	{ header: "SPAN", cell: (s) => s.spanName, maxWidth: 60 },
	{ header: "DURATION", cell: (s) => formatDuration(s.durationMs), align: right },
	{ header: "STATUS", cell: (s) => s.statusCode },
]

export const servicesView = (empty: string): View<ReadonlyArray<ServiceSummary>> => ({
	empty,
	table: (rows) => [
		{
			body: renderTable(
				[
					{ header: "SERVICE", cell: (s) => s.name },
					{ header: "THROUGHPUT", cell: (s) => formatCount(s.throughput), align: right },
					{ header: "ERRORS", cell: (s) => formatCount(s.errorCount), align: right },
					{ header: "ERROR RATE", cell: (s) => formatPercent(s.errorRate), align: right },
					{ header: "P50", cell: (s) => formatDuration(s.p50Ms), align: right },
					{ header: "P95", cell: (s) => formatDuration(s.p95Ms), align: right },
					{ header: "P99", cell: (s) => formatDuration(s.p99Ms), align: right },
				],
				rows,
			),
		},
	],
})

export type ErrorRow = ErrorSummary & { readonly serviceName?: string }

const servicesCell = (e: ErrorRow): string => {
	if (e.serviceName === undefined || e.serviceName === "") return String(e.affectedServicesCount)
	return e.affectedServicesCount > 1 ? `${e.serviceName} +${e.affectedServicesCount - 1}` : e.serviceName
}

export const errorsView = (empty: string): View<ReadonlyArray<ErrorRow>> => ({
	empty,
	table: (rows) => [
		{
			body: renderTable(
				[
					{ header: "ERROR", cell: (e) => e.label, maxWidth: 40 },
					{ header: "MESSAGE", cell: (e) => e.sampleMessage, maxWidth: 50 },
					{ header: "SERVICE", cell: servicesCell },
					{ header: "COUNT", cell: (e) => formatCount(e.count), align: right },
					{ header: "LAST SEEN", cell: (e) => formatTimestamp(e.lastSeen) },
					{ header: "FINGERPRINT", cell: (e) => e.fingerprintHash },
				],
				rows,
			),
		},
	],
})

const moreNote = (p: { readonly offset: number; readonly limit: number; readonly hasMore: boolean }) =>
	p.hasMore ? [`more results available: rerun with --offset ${p.offset + p.limit}`] : []

export const tracesView = (empty: string): View<SearchTracesOutput> => ({
	empty,
	isEmpty: (d) => d.spans.length === 0,
	table: (d) => [{ body: renderTable(spanColumns, d.spans) }],
	notes: (d) => moreNote(d.pagination),
})

export const slowTracesView = (empty: string): View<FindSlowTracesOutput> => ({
	empty,
	isEmpty: (d) => d.traces.length === 0,
	table: (d) => {
		const stats = d.stats
		const sections: Array<Section> =
			stats === null
				? []
				: [
						{
							body: renderFields([
								["p50", formatDuration(stats.p50Ms)],
								["p95", formatDuration(stats.p95Ms)],
								["min", formatDuration(stats.minMs)],
								["max", formatDuration(stats.maxMs)],
							]),
						},
					]
		return [...sections, { title: "SLOWEST TRACES", body: renderTable(spanColumns, d.traces) }]
	},
})

interface TreeRow {
	readonly label: string
	readonly span: SpanNode
}

/** Depth-first rows with box-drawing prefixes, so the tree reads top to bottom. */
const flattenTree = (nodes: ReadonlyArray<SpanNode>): ReadonlyArray<TreeRow> => {
	const rows: Array<TreeRow> = []
	const walk = (list: ReadonlyArray<SpanNode>, prefix: string, root: boolean) => {
		list.forEach((span, i) => {
			const last = i === list.length - 1
			const branch = root ? "" : last ? "└─ " : "├─ "
			rows.push({ label: `${prefix}${branch}${span.spanName}`, span })
			walk(span.children, root ? "" : `${prefix}${last ? "   " : "│  "}`, false)
		})
	}
	walk(nodes, "", true)
	return rows
}

export const traceView: View<InspectTraceOutput> = {
	isEmpty: (d) => d.spans.length === 0,
	table: (d) => {
		const sections: Array<Section> = [
			{
				body: renderFields([
					["trace", d.traceId],
					["duration", formatDuration(d.rootDurationMs)],
					["spans", formatCount(d.spanCount)],
					["services", formatCount(d.serviceCount)],
				]),
			},
			{
				title: "SPANS",
				body: renderTable<TreeRow>(
					[
						{ header: "SPAN", cell: (r) => r.label, maxWidth: 90 },
						{ header: "SERVICE", cell: (r) => r.span.serviceName },
						{ header: "DURATION", cell: (r) => formatDuration(r.span.durationMs), align: right },
						{
							header: "STATUS",
							cell: (r) =>
								r.span.statusMessage
									? `${r.span.statusCode}: ${r.span.statusMessage}`
									: r.span.statusCode,
							maxWidth: 60,
						},
					],
					flattenTree(d.spans),
				),
			},
		]
		if (d.logs.length > 0) {
			sections.push({
				title: "LOGS",
				body: renderTable(
					logColumns,
					d.logs.map((l) => ({ ...l, traceId: d.traceId })),
				),
			})
		}
		return sections
	},
}

export const diagnoseView: View<ServiceHealthOutput> = {
	isEmpty: () => false,
	table: (d) => {
		const h = d.health
		const sections: Array<Section> = [
			{
				body: renderFields([
					["service", d.serviceName],
					["window", `${d.timeRange.startTime} to ${d.timeRange.endTime} UTC`],
					["throughput", formatCount(h.throughput)],
					["errors", `${formatCount(h.errorCount)} (${formatPercent(h.errorRate)})`],
					["p50 / p95 / p99", [h.p50Ms, h.p95Ms, h.p99Ms].map(formatDuration).join(" / ")],
					["apdex", h.apdex.toFixed(3)],
				]),
			},
		]
		if (d.topErrors.length > 0) {
			sections.push({
				title: "TOP ERRORS",
				body: renderTable(
					[
						{ header: "ERROR", cell: (e) => e.label, maxWidth: 60 },
						{ header: "COUNT", cell: (e) => formatCount(e.count), align: right },
						{ header: "FINGERPRINT", cell: (e) => e.fingerprintHash },
					],
					d.topErrors,
				),
			})
		}
		if (d.recentTraces.length > 0) {
			sections.push({
				title: "RECENT TRACES",
				body: renderTable(
					[
						{ header: "TRACE ID", cell: (t) => t.traceId },
						{ header: "ROOT SPAN", cell: (t) => t.rootSpanName, maxWidth: 60 },
						{ header: "DURATION", cell: (t) => formatDuration(t.durationMs), align: right },
						{ header: "ERROR", cell: (t) => (t.hasError ? "yes" : "") },
					],
					d.recentTraces,
				),
			})
		}
		if (d.recentLogs.length > 0) {
			sections.push({ title: "RECENT LOGS", body: renderTable(logColumns, d.recentLogs) })
		}
		return sections
	},
}

export const logsView = (empty: string): View<SearchLogsOutput> => ({
	empty,
	isEmpty: (d) => d.logs.length === 0,
	table: (d) => [{ body: renderTable(logColumns, d.logs) }],
	notes: (d) => [
		`${formatCount(d.total)} matching log${d.total === 1 ? "" : "s"} in the window`,
		...moreNote(d.pagination),
	],
})

const topKeys = (counts: Readonly<Record<string, number>>, max: number): string => {
	const entries = Object.entries(counts).sort((a, b) => b[1] - a[1])
	const shown = entries.slice(0, max).map(([k]) => k)
	return entries.length > max ? `${shown.join(", ")} +${entries.length - max}` : shown.join(", ")
}

export const logPatternsView = (empty: string): View<MineLogPatternsOutput> => ({
	empty,
	isEmpty: (d) => d.patterns.length === 0,
	table: (d) => [
		{
			body: renderTable(
				[
					{ header: "COUNT", cell: (p) => formatCount(p.count), align: right },
					{ header: "SEVERITY", cell: (p) => topKeys(p.severityCounts, 2) },
					{ header: "SERVICES", cell: (p) => topKeys(p.serviceCounts, 2), maxWidth: 40 },
					{ header: "TEMPLATE", cell: (p) => p.template, maxWidth: 100 },
				],
				d.patterns,
			),
		},
	],
	notes: (d) => [`clustered ${formatCount(d.totalSampled)} sampled logs`],
})

export interface TopOperationRow {
	readonly name: string
	readonly value: number
	readonly metric: string
	readonly unit: "count" | "ms" | "ratio" | "score"
}

export const formatMetricValue = (value: number, unit: TopOperationRow["unit"]): string =>
	unit === "ms"
		? formatDuration(value)
		: unit === "ratio"
			? formatPercent(value)
			: unit === "count"
				? formatCount(value)
				: value.toFixed(3)

export const topOpsView = (empty: string): View<ReadonlyArray<TopOperationRow>> => ({
	empty,
	table: (rows) => [
		{
			body: renderTable(
				[
					{ header: "OPERATION", cell: (r) => r.name, maxWidth: 80 },
					{
						header: (rows[0]?.metric ?? "value").toUpperCase().replace(/_/g, " "),
						cell: (r) => formatMetricValue(r.value, r.unit),
						align: right,
					},
				],
				rows,
			),
		},
	],
})

export const errorDetailView = (empty: string): View<ErrorDetailOutput> => ({
	empty,
	isEmpty: (d) => d.traces.length === 0,
	table: (d) => {
		const sections: Array<Section> = []
		if (d.error !== undefined) {
			sections.push({
				body: renderFields([
					["error", d.error.label],
					["message", d.error.message],
					["service", d.error.serviceName],
					["fingerprint", d.fingerprintHash],
				]),
			})
		}
		sections.push({
			title: "SAMPLE TRACES",
			body: renderTable(
				[
					{ header: "TRACE ID", cell: (t) => t.traceId },
					{ header: "TIME", cell: (t) => formatTimestamp(t.startTime) },
					{ header: "ROOT SPAN", cell: (t) => t.rootSpanName, maxWidth: 50 },
					{ header: "DURATION", cell: (t) => formatDuration(t.durationMs), align: right },
					{ header: "SERVICES", cell: (t) => t.services.join(", "), maxWidth: 50 },
					{ header: "ERROR MESSAGE", cell: (t) => t.errorMessage, maxWidth: 60 },
				],
				d.traces,
			),
		})
		const series = d.timeseries ?? []
		if (series.length > 0) {
			sections.push({
				title: "OCCURRENCES",
				body: renderTable(
					[
						{ header: "BUCKET", cell: (p) => formatTimestamp(p.bucket) },
						{ header: "COUNT", cell: (p) => formatCount(p.count), align: right },
					],
					series,
				),
			})
		}
		return sections
	},
})

export interface CompareRow {
	readonly period: string
	readonly serviceName: string
	readonly environment?: string
	readonly throughput: number
	readonly errorCount: number
	readonly p95LatencyMs: number
	readonly p99LatencyMs: number
}

const change = (prev: number | undefined, cur: number | undefined, fmt: (n: number) => string): string =>
	`${prev === undefined ? "-" : fmt(prev)} -> ${cur === undefined ? "-" : fmt(cur)}`

/** One row per service and environment, previous window beside current. */
export const compareView = (empty: string): View<ReadonlyArray<CompareRow>> => ({
	empty,
	table: (rows) => {
		const keyOf = (r: CompareRow) => `${r.serviceName}\u0000${r.environment ?? ""}`
		const pairs = new Map<string, { previous?: CompareRow; current?: CompareRow }>()
		for (const row of rows) {
			const pair = pairs.get(keyOf(row)) ?? {}
			pairs.set(
				keyOf(row),
				row.period === "previous" ? { ...pair, previous: row } : { ...pair, current: row },
			)
		}
		const merged = Array.from(pairs.values())
		const pick = (p: { previous?: CompareRow; current?: CompareRow }) => p.current ?? p.previous
		const rate = (r: CompareRow | undefined) =>
			r === undefined ? undefined : r.throughput > 0 ? r.errorCount / r.throughput : 0
		return [
			{
				body: renderTable(
					[
						{ header: "SERVICE", cell: (p) => pick(p)?.serviceName ?? "" },
						{ header: "ENV", cell: (p) => pick(p)?.environment ?? "" },
						{
							header: "THROUGHPUT",
							cell: (p) => change(p.previous?.throughput, p.current?.throughput, formatCount),
						},
						{
							header: "ERROR RATE",
							cell: (p) => change(rate(p.previous), rate(p.current), formatPercent),
						},
						{
							header: "P95",
							cell: (p) =>
								change(p.previous?.p95LatencyMs, p.current?.p95LatencyMs, formatDuration),
						},
						{
							header: "P99",
							cell: (p) =>
								change(p.previous?.p99LatencyMs, p.current?.p99LatencyMs, formatDuration),
						},
					],
					merged,
				),
			},
		]
	},
	notes: () => ["previous window -> current window"],
})

export interface MetricSeriesOutput {
	readonly metricName: string
	readonly metricType: string
	readonly unit: string
	readonly isMonotonic: boolean
	readonly aggregation: "rate" | "avg"
	readonly bucketSeconds: number
	readonly points: ReadonlyArray<{
		readonly bucket: string
		readonly service: string
		readonly value: number
	}>
}

export const metricSeriesView = (empty: string): View<MetricSeriesOutput> => ({
	empty,
	isEmpty: (d) => d.points.length === 0,
	table: (d) => {
		const unit = d.aggregation === "rate" ? `${d.unit || "1"}/s` : d.unit
		return [
			{
				body: renderFields([
					["metric", d.metricName],
					["type", `${d.metricType}${d.isMonotonic ? " (monotonic)" : ""}`],
					["value", d.aggregation === "rate" ? "per-second rate" : "average"],
					["unit", unit || "-"],
					["bucket", `${d.bucketSeconds}s`],
				]),
			},
			{
				title: "POINTS",
				body: renderTable(
					[
						{ header: "BUCKET", cell: (p) => formatTimestamp(p.bucket) },
						{ header: "SERVICE", cell: (p) => p.service },
						{ header: "VALUE", cell: (p) => formatDecimal(p.value), align: right },
					],
					d.points,
				),
			},
		]
	},
})
