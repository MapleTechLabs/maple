// Remote implementations that go through the hosted MCP tools (see
// `mcp-client.ts`) because v2 has no resource for them. Like `remote-ops.ts`,
// each returns local mode's output type, so commands and renderers never learn
// which backend answered. Where the tool reports less than local mode, the
// missing field is left empty rather than invented.

import { Effect, Schema } from "effect"
import { TraceId } from "@maple/domain"
import type { TracesMetric } from "@maple/query-engine"
import type {
	AttributeKeyResult,
	AttributeValueResult,
	ErrorDetailOutput,
	FindSlowTracesOutput,
	MineLogPatternsOutput,
	SearchLogsOutput,
	SearchTracesOutput,
	ServiceHealthOutput,
	SpanResult,
} from "@maple/query-engine/observability"
import type { CompareRow, ErrorRow } from "../lib/views"
import type { MapleMcpClient, McpToolOutput } from "./mcp-client"
import type { Range } from "./time"

const window = (range: Range) => ({ start_time: range.startTime, end_time: range.endTime })

const toTimeRange = (r: { readonly start: string; readonly end: string }) => ({
	startTime: r.start,
	endTime: r.end,
})

const decodeTraceId = Schema.decodeUnknownSync(TraceId)

/** The MCP log tools take OTel's `WARN` only; the CLI also accepts `WARNING`. */
const mcpSeverity = (severity: string | undefined) => (severity === "WARNING" ? "WARN" : severity)

type TraceSummary = McpToolOutput<"search_traces">["traces"][number]

/**
 * A tool's trace summary as local mode's span row. The tools report error-or-not
 * rather than the status code, and no span id; those stay empty.
 */
const summaryToSpan = (t: TraceSummary): SpanResult => ({
	traceId: decodeTraceId(t.traceId),
	spanId: null,
	spanName: t.rootSpanName,
	serviceName: t.services[0] ?? "",
	durationMs: t.durationMs,
	statusCode: t.hasError ? "Error" : "",
	statusMessage: t.errorMessage ?? "",
	attributes: {},
	resourceAttributes: t.resourceAttributes ?? {},
	timestamp: t.startTime ?? "",
})

export const findErrors = (
	mcp: MapleMcpClient,
	p: { range: Range; service?: string; environment?: string; limit?: number },
) =>
	Effect.map(
		mcp.call("find_errors", {
			...window(p.range),
			service: p.service,
			environment: p.environment,
			limit: p.limit,
		}),
		// The tool counts affected services but does not name one; a --service
		// filter is the only name known for certain.
		(out) =>
			out.errors.map((e): ErrorRow => (p.service === undefined ? e : { ...e, serviceName: p.service })),
	)

export const errorDetail = (
	mcp: MapleMcpClient,
	p: { fingerprintHash: string; range: Range; service?: string; limit?: number },
) =>
	Effect.map(
		mcp.call("error_detail", {
			fingerprint: p.fingerprintHash,
			...window(p.range),
			service: p.service,
			include_timeseries: true,
			// The tool caps sample traces at 20.
			limit: p.limit === undefined ? undefined : Math.min(p.limit, 20),
		}),
		(out): ErrorDetailOutput => ({
			fingerprintHash: out.fingerprintHash,
			timeRange: toTimeRange(out.timeRange),
			...(out.error === undefined ? undefined : { error: out.error }),
			traces: out.traces.map((t) => ({
				traceId: t.traceId,
				rootSpanName: t.rootSpanName,
				durationMs: t.durationMs,
				spanCount: t.spanCount,
				services: t.services,
				startTime: t.startTime,
				errorMessage: t.errorMessage ?? "",
				errorSpan: t.errorSpan,
				logs: t.logs,
			})),
			...(out.timeseries === undefined ? undefined : { timeseries: out.timeseries }),
		}),
	)

export const diagnoseService = (
	mcp: MapleMcpClient,
	p: { serviceName: string; range: Range; environment?: string },
) =>
	Effect.map(
		mcp.call("diagnose_service", {
			service: p.serviceName,
			...window(p.range),
			environment: p.environment,
		}),
		(out): ServiceHealthOutput => ({
			serviceName: out.serviceName,
			timeRange: toTimeRange(out.timeRange),
			health: out.health,
			topErrors: out.topErrors,
			recentTraces: out.recentTraces.map((t) => ({
				traceId: t.traceId,
				rootSpanName: t.rootSpanName,
				durationMs: t.durationMs,
				hasError: t.hasError,
			})),
			recentLogs: out.recentLogs.map((l) => ({
				timestamp: l.timestamp,
				severityText: l.severityText,
				serviceName: l.serviceName,
				body: l.body,
				traceId: l.traceId ?? "",
				spanId: l.spanId ?? "",
			})),
		}),
	)

export const findSlowTraces = (
	mcp: MapleMcpClient,
	p: { range: Range; service?: string; environment?: string; limit?: number },
) =>
	Effect.map(
		mcp.call("find_slow_traces", {
			...window(p.range),
			service: p.service,
			environment: p.environment,
			limit: p.limit,
		}),
		(out): FindSlowTracesOutput => ({
			timeRange: toTimeRange(out.timeRange),
			stats: out.stats ?? null,
			traces: out.traces.map(summaryToSpan),
		}),
	)

/** Span-level search and numeric offsets, which `/v2/traces/search` cannot express. */
export const searchTraces = (
	mcp: MapleMcpClient,
	p: {
		range: Range
		service?: string
		spanName?: string
		hasError?: boolean
		minDurationMs?: number
		maxDurationMs?: number
		httpMethod?: string
		traceId?: string
		rootOnly?: boolean
		limit?: number
		offset?: number
	},
) =>
	Effect.map(
		mcp.call("search_traces", {
			...window(p.range),
			service: p.service,
			span_name: p.spanName,
			has_error: p.hasError,
			min_duration_ms: p.minDurationMs,
			max_duration_ms: p.maxDurationMs,
			http_method: p.httpMethod,
			trace_id: p.traceId,
			root_only: p.rootOnly,
			limit: p.limit,
			offset: p.offset,
		}),
		(out): SearchTracesOutput => ({
			timeRange: toTimeRange(out.timeRange),
			spans: out.traces.map(summaryToSpan),
			pagination: {
				offset: out.pagination?.offset ?? p.offset ?? 0,
				limit: out.pagination?.limit ?? p.limit ?? out.traces.length,
				hasMore: out.pagination?.hasMore ?? false,
			},
		}),
	)

/** Numeric offsets, which `/v2/logs/search` (cursor-paged) cannot seek to. */
export const searchLogs = (
	mcp: MapleMcpClient,
	p: {
		range: Range
		service?: string
		severity?: string
		search?: string
		traceId?: string
		limit?: number
		offset?: number
	},
) =>
	Effect.map(
		mcp.call("search_logs", {
			...window(p.range),
			service: p.service,
			severity: mcpSeverity(p.severity),
			search: p.search,
			trace_id: p.traceId,
			limit: p.limit,
			offset: p.offset,
		}),
		(out): SearchLogsOutput => ({
			timeRange: toTimeRange(out.timeRange),
			total: out.totalCount,
			logs: out.logs.map((l) => ({ ...l, traceId: l.traceId ?? "", spanId: l.spanId ?? "" })),
			pagination: {
				offset: out.pagination?.offset ?? p.offset ?? 0,
				limit: out.pagination?.limit ?? p.limit ?? out.logs.length,
				hasMore: out.pagination?.hasMore ?? false,
			},
		}),
	)

export const mineLogPatterns = (
	mcp: MapleMcpClient,
	p: { range: Range; service?: string; severity?: string; search?: string; limit?: number },
) =>
	Effect.map(
		mcp.call("mine_log_patterns", {
			...window(p.range),
			service: p.service,
			severity: mcpSeverity(p.severity),
			search: p.search,
			limit: p.limit,
		}),
		(out): MineLogPatternsOutput => ({
			timeRange: toTimeRange(out.timeRange),
			sampleSize: out.sampleSize,
			totalSampled: out.totalSampled,
			patterns: out.patterns,
		}),
	)

export const topOperations = (
	mcp: MapleMcpClient,
	p: { serviceName: string; metric: TracesMetric; range: Range; limit?: number },
) =>
	Effect.map(
		mcp.call("get_service_top_operations", {
			service: p.serviceName,
			metric: p.metric,
			...window(p.range),
			limit: p.limit,
		}),
		(out) => out.operations,
	)

type AttrSource = "traces" | "metrics" | "services"

export const attributeKeys = (
	mcp: MapleMcpClient,
	p: { source: AttrSource; scope?: "span" | "resource"; service?: string; range: Range; limit?: number },
) =>
	Effect.map(
		mcp.call("explore_attributes", {
			source: p.source,
			scope: p.scope,
			service: p.service,
			...window(p.range),
			limit: p.limit,
		}),
		(out): ReadonlyArray<AttributeKeyResult> =>
			p.source === "services"
				? [
						...(out.environments ?? []).map((e) => ({
							key: `environment:${e.name}`,
							count: e.count,
							facetType: "environment",
						})),
						...(out.commitShas ?? []).map((c) => ({
							key: `commit_sha:${c.name}`,
							count: c.count,
							facetType: "commit_sha",
						})),
					]
				: (out.keys ?? []),
	)

export const attributeValues = (
	mcp: MapleMcpClient,
	p: {
		key: string
		source: AttrSource
		scope?: "span" | "resource"
		service?: string
		range: Range
		limit?: number
	},
) =>
	Effect.map(
		mcp.call("explore_attributes", {
			source: p.source,
			scope: p.scope,
			key: p.key,
			service: p.service,
			...window(p.range),
			limit: p.limit,
		}),
		(out): ReadonlyArray<AttributeValueResult> => out.values ?? [],
	)

/**
 * `compare_periods` reports throughput, error rate and p95 per service, summed
 * across environments. Rows are emitted only for a window the service had
 * traffic in, as local mode's are; p99 is not reported, so it is absent.
 */
export const compareServiceOverview = (
	mcp: MapleMcpClient,
	p: { current: Range; previous: Range; environment?: string },
) =>
	Effect.map(
		mcp.call("compare_periods", {
			current_start: p.current.startTime,
			current_end: p.current.endTime,
			previous_start: p.previous.startTime,
			previous_end: p.previous.endTime,
			environment: p.environment,
		}),
		(out) =>
			out.services.flatMap((s) =>
				(["previous", "current"] as const).flatMap((period): ReadonlyArray<CompareRow> => {
					const stats = s[period]
					if (stats.throughput <= 0) return []
					return [
						{
							period,
							serviceName: s.name,
							...(p.environment === undefined ? undefined : { environment: p.environment }),
							throughput: stats.throughput,
							errorCount: Math.round(stats.errorRate * stats.throughput),
							p95LatencyMs: stats.p95Ms,
						},
					]
				}),
			),
	)

export interface RawQueryResult {
	readonly rows: ReadonlyArray<Record<string, unknown>>
	/** Set when the workspace returned fewer rows than the query produced. */
	readonly truncatedFrom?: number
}

export const rawQuery = (mcp: MapleMcpClient, p: { sql: string; range: Range }) =>
	Effect.map(mcp.call("run_sql", { sql: p.sql, ...window(p.range) }), (out): RawQueryResult => ({
		rows: out.rows,
		...(out.truncated ? { truncatedFrom: out.rowCount } : undefined),
	}))
