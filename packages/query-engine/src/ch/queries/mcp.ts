// MCP hub reads (`/mcp-servers`): SERVER spans with `mcp.method.name`, always narrowed by ServiceName
// (an unscoped attribute scan times out). A call is a `tools/call` span and failed when `error.type`
// is set; callers' own mistakes carry none. Clients are grouped by family in SQL, never by raw agent.

import * as CH from "@maple-dev/effect-orm/expr"
import { from, param, type ColumnAccessor } from "@maple-dev/effect-orm/clickhouse"
import {
	KNOWN_MCP_CLIENTS,
	MCP_CLIENT_TOKEN_PATTERN,
	UNKNOWN_MCP_CLIENT,
	type McpClientKind,
} from "@maple/domain/mcp-clients"
import { ServiceOperationsHourly, Traces, orgIdParam, utcSecondsParam } from "../tables"
import { finiteOrZero, isoBucket } from "./format"

/** The toolbar's selection, applied in SQL so percentiles are measured over what is shown. */
export interface McpCallFilter {
	/** Exact `gen_ai.tool.name`. */
	readonly tool?: string
	/** Case-insensitive tool-name substring. */
	readonly search?: string
	/** A client family name, as {@link mcpClientName} computes it. */
	readonly client?: string
	readonly kind?: McpClientKind
	readonly failingOnly?: boolean
}

const likeLiteral = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`)

type TracesRow = ColumnAccessor<typeof Traces.columns>

const method = ($: TracesRow) => $.SpanAttributes.get("mcp.method.name")
const toolName = ($: TracesRow) => $.SpanAttributes.get("gen_ai.tool.name")
const errorType = ($: TracesRow) => $.SpanAttributes.get("error.type")
const userAgent = ($: TracesRow) => $.SpanAttributes.get("user_agent.original")
const failed = ($: TracesRow) => errorType($).neq("")

const knownClient = ($: TracesRow, prefix: string) =>
	CH.positionCaseInsensitive(userAgent($), CH.lit(prefix)).eq(1)

/** `mcpClientOf(user agent).name`, in SQL. */
export const mcpClientName = ($: TracesRow): CH.Expr<string> =>
	CH.multiIf<string>(
		[
			[userAgent($).eq(""), CH.lit(UNKNOWN_MCP_CLIENT)],
			...KNOWN_MCP_CLIENTS.map(
				(client) => [knownClient($, client.prefix), CH.lit(client.name)] as const,
			),
		],
		CH.extract_(userAgent($), MCP_CLIENT_TOKEN_PATTERN),
	)

/** `mcpClientOf(user agent).kind`, in SQL. */
const mcpClientKind = ($: TracesRow): CH.Expr<string> =>
	CH.multiIf<string>(
		KNOWN_MCP_CLIENTS.map(
			(client) => [knownClient($, client.prefix), CH.lit(String(client.kind))] as const,
		),
		CH.lit("unknown"),
	)

const inWindow = ($: TracesRow) => [
	$.OrgId.eq(orgIdParam),
	$.Timestamp.gte(param.dateTime("startTime")),
	$.Timestamp.lte(param.dateTime("endTime")),
	$.SpanKind.eq("Server"),
]

/** One service's MCP server spans in the window. */
const serverSpans = ($: TracesRow) => [
	...inWindow($),
	$.ServiceName.eq(param.string("serviceName")),
	method($).neq(""),
]

/** One service's tool calls under the selection. */
const calls = ($: TracesRow, filter: McpCallFilter) => [
	...serverSpans($),
	method($).eq("tools/call"),
	CH.when(filter.tool, (tool) => toolName($).eq(tool)),
	CH.when(filter.search, (search) => toolName($).ilike(`%${likeLiteral(search)}%`)),
	CH.when(filter.client, (client) => mcpClientName($).eq(client)),
	CH.when(filter.kind, (kind) => mcpClientKind($).eq(kind)),
	CH.when(filter.failingOnly === true ? true : undefined, () => failed($)),
]

/** The listed services' tool calls in the window. */
const serverCalls = ($: TracesRow, services: ReadonlyArray<string>) => [
	...inWindow($),
	CH.inList($.ServiceName, services),
	method($).eq("tools/call"),
]

const percentiles = ($: { readonly Duration: CH.Expr<number> }) => ({
	p50: finiteOrZero(CH.quantile(0.5)($.Duration)),
	p90: finiteOrZero(CH.quantile(0.9)($.Duration)),
	p95: finiteOrZero(CH.quantile(0.95)($.Duration)),
})

/** Services answering `tools/call` as a server in the window, from the hourly operations rollup. */
export function mcpServicesQuery() {
	return from(ServiceOperationsHourly)
		.select(($) => ({
			service: $.ServiceName,
			serverSpans: CH.sum($.ServerSpanCount),
		}))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			// The hour holding the window's start counts.
			$.Hour.gte(CH.toStartOfHour(CH.toDateTime(utcSecondsParam("startTime")))),
			$.Hour.lte(utcSecondsParam("endTime")),
			$.SpanName.like("tools/call %"),
		])
		.groupBy("service")
		.orderBy(["serverSpans", "desc"])
		.limit(100)
		.format("JSON")
}

/** One row per server across the listed services: its calls, failures and the latest call. */
export function mcpServerStatsQuery(services: ReadonlyArray<string>) {
	return from(Traces)
		.select(($) => ({
			service: $.ServiceName,
			protocolVersion: CH.any_($.SpanAttributes.get("mcp.protocol.version")),
			calls: CH.count(),
			errors: CH.countIf(failed($)),
			p95: finiteOrZero(CH.quantile(0.95)($.Duration)),
			tools: CH.uniqExact(toolName($)),
			lastCall: CH.max_($.Timestamp),
		}))
		.where(($) => serverCalls($, services))
		.groupBy("service")
		.format("JSON")
}

/** Calls per (service, bucket), for the list's sparks. */
export function mcpServerSparkQuery(services: ReadonlyArray<string>) {
	return from(Traces)
		.select(($) => ({ service: $.ServiceName, bucket: isoBucket($.Timestamp), calls: CH.count() }))
		.where(($) => serverCalls($, services))
		.groupBy("service", "bucket")
		.format("JSON")
}

/** Calls per (service, client family), for the list's top client. */
export function mcpServerClientsQuery(services: ReadonlyArray<string>) {
	return from(Traces)
		.select(($) => ({ service: $.ServiceName, client: mcpClientName($), calls: CH.count() }))
		.where(($) => serverCalls($, services))
		.groupBy("service", "client")
		.format("JSON")
}

/** Per client family under the selection: its kind, calls and failures. */
export function mcpClientsQuery(filter: McpCallFilter = {}) {
	return from(Traces)
		.select(($) => ({
			client: mcpClientName($),
			kind: CH.any_(mcpClientKind($)),
			calls: CH.count(),
			errors: CH.countIf(failed($)),
		}))
		.where(($) => calls($, filter))
		.groupBy("client")
		.orderBy(["calls", "desc"])
		.limit(500)
		.format("JSON")
}

/** One service's server spans per (method, error type): failures and the coverage checklist's counts. */
export function mcpSpanSummaryQuery() {
	return from(Traces)
		.select(($) => ({
			method: method($),
			errorType: errorType($),
			spans: CH.count(),
			withToolName: CH.countIf(toolName($).neq("")),
			withUserAgent: CH.countIf(userAgent($).neq("")),
			withSession: CH.countIf($.SpanAttributes.get("mcp.session.id").neq("")),
			// A call with a caller span from `params._meta` links the HTTP span instead of hanging off it.
			withCallerTrace: CH.countIf(CH.arrayElement($.LinksTraceId, 1).neq("")),
			withMessage: CH.countIf($.StatusMessage.neq("")),
			firstSpan: CH.min_($.Timestamp),
			protocolVersion: CH.any_($.SpanAttributes.get("mcp.protocol.version")),
			transport: CH.any_($.SpanAttributes.get("network.transport")),
		}))
		.where(serverSpans)
		.groupBy("method", "errorType")
		.limit(1_000)
		.format("JSON")
}

/** `clientInfo.name` counts from `initialize` spans. */
export function mcpInitializersQuery() {
	return from(Traces)
		.select(($) => ({ name: $.SpanAttributes.get("maple.mcp.client.name"), count: CH.count() }))
		.where(($) => [
			...serverSpans($),
			method($).eq("initialize"),
			$.SpanAttributes.get("maple.mcp.client.name").neq(""),
		])
		.groupBy("name")
		.orderBy(["count", "desc"])
		.limit(50)
		.format("JSON")
}

/** Per method: span count and latency, unfiltered. */
export function mcpMethodsQuery() {
	return from(Traces)
		.select(($) => ({ method: method($), calls: CH.count(), ...percentiles($) }))
		.where(serverSpans)
		.groupBy("method")
		.orderBy(["calls", "desc"])
		.limit(50)
		.format("JSON")
}

/** The selection's totals: calls, failures, status errors, percentiles and first/last call. */
export function mcpCallTotalsQuery(filter: McpCallFilter = {}) {
	return from(Traces)
		.select(($) => ({
			calls: CH.count(),
			errors: CH.countIf(failed($)),
			statusErrors: CH.countIf($.StatusCode.eq("Error")),
			...percentiles($),
			firstCall: CH.min_($.Timestamp),
			lastCall: CH.max_($.Timestamp),
		}))
		.where(($) => calls($, filter))
		.format("JSON")
}

/** The selection's merged series: calls, failures and percentiles per bucket. */
export function mcpCallSeriesQuery(filter: McpCallFilter = {}) {
	return from(Traces)
		.select(($) => ({
			bucket: isoBucket($.Timestamp),
			calls: CH.count(),
			errors: CH.countIf(failed($)),
			...percentiles($),
		}))
		.where(($) => calls($, filter))
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.format("JSON")
}

/** Calls and failures per (bucket, key): `tool` for the tools table's sparks, `client` for clients. */
export function mcpCallSplitSeriesQuery(split: "tool" | "client", filter: McpCallFilter = {}) {
	return from(Traces)
		.select(($) => ({
			bucket: isoBucket($.Timestamp),
			key: split === "tool" ? toolName($) : mcpClientName($),
			calls: CH.count(),
			errors: CH.countIf(failed($)),
		}))
		.where(($) => calls($, filter))
		.groupBy("bucket", "key")
		.format("JSON")
}

/** The tools table: per tool, calls, failures, percentiles, one error type it failed with, last call. */
export function mcpToolStatsQuery(filter: McpCallFilter = {}) {
	return from(Traces)
		.select(($) => ({
			tool: toolName($),
			calls: CH.count(),
			errors: CH.countIf(failed($)),
			...percentiles($),
			topError: CH.anyIf(errorType($), failed($)),
			lastCall: CH.max_($.Timestamp),
		}))
		.where(($) => calls($, filter))
		.groupBy("tool")
		.orderBy(["calls", "desc"])
		.limit(500)
		.format("JSON")
}

/** One tool's failures grouped by error type and status message, with each group's reach. */
export function mcpErrorGroupsQuery(filter: McpCallFilter) {
	return from(Traces)
		.select(($) => ({
			errorType: errorType($),
			message: $.StatusMessage,
			count: CH.count(),
			clients: CH.uniqExact(mcpClientName($)),
			lastSeen: CH.max_($.Timestamp),
		}))
		.where(($) => [...calls($, filter), failed($)])
		.groupBy("errorType", "message")
		.orderBy(["count", "desc"])
		.limit(50)
		.format("JSON")
}

/** Failures per (bucket, error type, message) for the listed groups' trends. */
export function mcpErrorTrendQuery(filter: McpCallFilter, messages: ReadonlyArray<string>) {
	return from(Traces)
		.select(($) => ({
			bucket: isoBucket($.Timestamp),
			errorType: errorType($),
			message: $.StatusMessage,
			count: CH.count(),
		}))
		.where(($) => [...calls($, filter), failed($), CH.inList($.StatusMessage, messages)])
		.groupBy("bucket", "errorType", "message")
		.format("JSON")
}

export type McpCallOrder = "slowest" | "failed" | "recent"

/** A page of single calls: the slowest, the latest failures, or the latest. */
export function mcpCallListQuery(order: McpCallOrder, filter: McpCallFilter, limit = 20) {
	return from(Traces)
		.select(($) => ({
			timestamp: $.Timestamp,
			client: mcpClientName($),
			requestId: $.SpanAttributes.get("jsonrpc.request.id"),
			duration: $.Duration,
			errorType: errorType($),
			traceId: $.TraceId,
			spanId: $.SpanId,
		}))
		.where(($) => [...calls($, filter), CH.when(order === "failed" ? true : undefined, () => failed($))])
		.orderBy(order === "slowest" ? ["duration", "desc"] : ["timestamp", "desc"])
		.limit(limit)
		.format("JSON")
}
