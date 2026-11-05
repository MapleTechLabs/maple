// MCP hub reads (`/mcp-servers`): SERVER spans with `mcp.method.name`, always narrowed by ServiceName
// (an unscoped attribute scan times out). A call is a `tools/call` span and failed when `error.type`
// is set; callers' own mistakes carry none. Clients are grouped by family in SQL, never by raw agent.

import * as CH from "@maple-dev/effect-orm/expr"
import { from, fromQuery, param, type ColumnAccessor } from "@maple-dev/effect-orm/clickhouse"
import * as T from "@maple-dev/effect-orm/clickhouse"
import {
	KNOWN_MCP_CLIENTS,
	MCP_CLIENT_TOKEN_PATTERN,
	UNKNOWN_MCP_CLIENT,
	type McpClientKind,
} from "@maple/domain/mcp-clients"
import { ServiceOperationsHourly, Traces, orgIdParam, utcSecondsParam } from "../tables"
import { finiteOrZero, isoBucket } from "./format"
import { Array as Arr } from "effect"

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

export const method = ($: TracesRow) => $.SpanAttributes.get("mcp.method.name")
const toolName = ($: TracesRow) => $.SpanAttributes.get("gen_ai.tool.name")
const errorType = ($: TracesRow) => $.SpanAttributes.get("error.type")
const userAgent = ($: TracesRow) => $.SpanAttributes.get("user_agent.original")
const failed = ($: TracesRow) => errorType($).neq("")
/**
 * Why a call failed: the status message, else `error.message`. An `isError` tool result is a
 * successful JSON-RPC call with status Ok, so its reason can only ride on the attribute.
 */
const errorMessage = ($: TracesRow) =>
	CH.if_($.StatusMessage.neq(""), $.StatusMessage, $.SpanAttributes.get("error.message"))

/** The end user: OpenTelemetry `user.id`, else the deprecated `enduser.id`. */
export const userId = ($: TracesRow) =>
	CH.if_(
		$.SpanAttributes.get("user.id").neq(""),
		$.SpanAttributes.get("user.id"),
		$.SpanAttributes.get("enduser.id"),
	)
/** What the page calls the user: `user.name`, else `user.email`. */
const userLabel = ($: TracesRow) =>
	CH.if_(
		$.SpanAttributes.get("user.name").neq(""),
		$.SpanAttributes.get("user.name"),
		$.SpanAttributes.get("user.email"),
	)

/** Any non-empty value in the group, `''` only when no span sent one. */
const nonEmpty = (value: CH.Expr<string>) => CH.anyIf(value, value.neq(""))

const knownClient = ($: TracesRow, prefix: string) =>
	CH.positionCaseInsensitive(userAgent($), CH.lit(prefix)).eq(1)

/** `mcpClientOf(user agent).name`, in SQL. */
export const mcpClientName = ($: TracesRow): CH.Expr<string> => {
	const token = CH.extract_(userAgent($), MCP_CLIENT_TOKEN_PATTERN)
	return CH.multiIf<string>(
		[
			...Arr.map(
				KNOWN_MCP_CLIENTS,
				(client) => [knownClient($, client.prefix), CH.lit(client.name)] as const,
			),
			[token.eq(""), CH.lit(UNKNOWN_MCP_CLIENT)],
		],
		token,
	)
}

/** `mcpClientOf(user agent).kind`, in SQL. */
const mcpClientKind = ($: TracesRow): CH.Expr<string> =>
	CH.multiIf<string>(
		Arr.map(
			KNOWN_MCP_CLIENTS,
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
			$.SpanName.like("tools/call %").or($.SpanName.eq("tools/call")),
		])
		.groupBy("service")
		.orderBy(["serverSpans", "desc"])
		.limit(100)
		.format("JSON")
}

/** The hour of one service's first MCP tool call on record, from the hourly operations rollup. */
export function mcpFirstSeenQuery() {
	return from(ServiceOperationsHourly)
		.select(($) => ({ firstHour: CH.min_($.Hour) }))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.ServiceName.eq(param.string("serviceName")),
			$.Hour.lte(utcSecondsParam("endTime")),
			$.SpanName.like("tools/call %").or($.SpanName.eq("tools/call")),
		])
		.format("JSON")
}

/** One row per server across the listed services: its calls, failures and the latest call. */
export function mcpServerStatsQuery(services: ReadonlyArray<string>) {
	return from(Traces)
		.select(($) => ({
			service: $.ServiceName,
			protocolVersion: nonEmpty($.SpanAttributes.get("mcp.protocol.version")),
			calls: CH.count(),
			errors: CH.countIf(failed($)),
			p95: finiteOrZero(CH.quantile(0.95)($.Duration)),
			tools: CH.uniqExact(CH.nullIf(toolName($), "")),
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

/**
 * Per client family across every MCP request, not just tool calls: its connects (`initialize`),
 * distinct `client.address` values and last request. Finds the clients that connect and never call.
 */
export function mcpClientReachQuery(filter: Pick<McpCallFilter, "client" | "kind"> = {}) {
	return from(Traces)
		.select(($) => ({
			client: mcpClientName($),
			kind: CH.any_(mcpClientKind($)),
			calls: CH.countIf(method($).eq("tools/call")),
			errors: CH.countIf(method($).eq("tools/call").and(failed($))),
			connects: CH.countIf(method($).eq("initialize")),
			sources: CH.uniqExact(CH.nullIf($.SpanAttributes.get("client.address"), "")),
			lastSeen: CH.max_($.Timestamp),
		}))
		.where(($) => [
			...serverSpans($),
			CH.when(filter.client, (client) => mcpClientName($).eq(client)),
			CH.when(filter.kind, (kind) => mcpClientKind($).eq(kind)),
		])
		.groupBy("client")
		.orderBy(["connects", "desc"])
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
			withUser: CH.countIf(userId($).neq("")),
			// In a session either way: the two counts above overlap where a call carries both.
			inSession: CH.countIf($.SpanAttributes.get("mcp.session.id").neq("").or(userId($).neq(""))),
			// A call with a caller span from `params._meta` links the HTTP span instead of hanging off it.
			withCallerTrace: CH.countIf(CH.arrayElement($.LinksTraceId, 1).neq("")),
			withMessage: CH.countIf(errorMessage($).neq("")),
			firstSpan: CH.min_($.Timestamp),
			protocolVersion: nonEmpty($.SpanAttributes.get("mcp.protocol.version")),
			transport: nonEmpty($.SpanAttributes.get("network.transport")),
		}))
		.where(serverSpans)
		.groupBy("method", "errorType")
		.limit(1_000)
		.format("JSON")
}

/** Requests per `clientInfo.name`: `initialize` sends it, a stateless request sends it in `_meta`. */
export function mcpClientInfoQuery() {
	return from(Traces)
		.select(($) => ({
			name: $.SpanAttributes.get("maple.mcp.client.name"),
			count: CH.count(),
			connects: CH.countIf(method($).eq("initialize")),
		}))
		.where(($) => [...serverSpans($), $.SpanAttributes.get("maple.mcp.client.name").neq("")])
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
			tools: CH.uniqExact(CH.nullIf(toolName($), "")),
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

/** The tools table: per named tool, calls, failures, percentiles and last call. */
export function mcpToolStatsQuery(filter: McpCallFilter = {}) {
	return from(Traces)
		.select(($) => ({
			tool: toolName($),
			calls: CH.count(),
			errors: CH.countIf(failed($)),
			...percentiles($),
			lastCall: CH.max_($.Timestamp),
		}))
		.where(($) => [...calls($, filter), toolName($).neq("")])
		.groupBy("tool")
		.orderBy(["calls", "desc"])
		.limit(500)
		.format("JSON")
}

/** Failed calls per (tool, error type) under the selection: each tool's top error and the failure kinds. */
export function mcpToolErrorsQuery(filter: McpCallFilter = {}) {
	return from(Traces)
		.select(($) => ({ tool: toolName($), errorType: errorType($), count: CH.count() }))
		.where(($) => [...calls($, filter), failed($)])
		.groupBy("tool", "errorType")
		.orderBy(["count", "desc"])
		.limit(5_000)
		.format("JSON")
}

/** One tool's failures grouped by error type and status message, with each group's reach. */
export function mcpErrorGroupsQuery(filter: McpCallFilter) {
	return from(Traces)
		.select(($) => ({
			errorType: errorType($),
			message: errorMessage($),
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
			message: errorMessage($),
			count: CH.count(),
		}))
		.where(($) => [...calls($, filter), failed($), CH.inList(errorMessage($), messages)])
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

// Sessions: one server's requests grouped by `mcp.session.id`, which only a stateful transport
// issues. A stateless server's requests carrying `user.id` join a user's sessions instead, split by
// the backend at an idle gap. A session's client is read off its requests, which all carry the same one.

const sessionId = ($: TracesRow) => $.SpanAttributes.get("mcp.session.id")
const failedCall = ($: TracesRow) => method($).eq("tools/call").and(failed($))

/** The sessions toolbar's selection. */
export interface McpSessionFilter {
	readonly client?: string
	readonly kind?: McpClientKind
	/** Case-insensitive substring of the session id or the user id. */
	readonly search?: string
	/** Sessions with at least one failed tool call. */
	readonly failingOnly?: boolean
	/** One user's requests, by exact `user.id`. */
	readonly user?: string
	/** Only spans whose resource `service.namespace` is one of these; empty or absent is every one. */
	readonly namespaces?: ReadonlyArray<string>
}

const selected = ($: TracesRow, filter: McpSessionFilter) => [
	CH.when(filter.client, (client) => mcpClientName($).eq(client)),
	CH.when(filter.kind, (kind) => mcpClientKind($).eq(kind)),
	CH.when(filter.user, (user) => userId($).eq(user)),
	filter.namespaces?.length
		? CH.inList($.ResourceAttributes.get("service.namespace"), filter.namespaces)
		: undefined,
	// Ids every request of a session carries, so a match keeps whole sessions.
	CH.when(filter.search, (search) => {
		const pattern = `%${likeLiteral(search)}%`
		return sessionId($).ilike(pattern).or(userId($).ilike(pattern))
	}),
]

/** Requests in a session the server issued. */
const sessionRequests = ($: TracesRow, filter: McpSessionFilter) => [
	...serverSpans($),
	sessionId($).neq(""),
	...selected($, filter),
]

/** A stateless server's requests from a known user: the stuff of user sessions. */
const userRequests = ($: TracesRow, filter: McpSessionFilter) => [
	...serverSpans($),
	sessionId($).eq(""),
	userId($).neq(""),
	...selected($, filter),
]

const issuedSessionColumns = ($: TracesRow) => ({
	sessionId: sessionId($),
	client: CH.anyIf(mcpClientName($), userAgent($).neq("")),
	kind: CH.anyIf(mcpClientKind($), userAgent($).neq("")),
	user: nonEmpty(userId($)),
	userName: nonEmpty(userLabel($)),
	requests: CH.count(),
	calls: CH.countIf(method($).eq("tools/call")),
	errors: CH.countIf(failedCall($)),
	tools: CH.uniqExact(CH.nullIf(toolName($), "")),
	firstSeen: CH.min_($.Timestamp),
	lastSeen: CH.max_($.Timestamp),
})

/** One row per issued session under the selection, the latest first. */
export function mcpSessionListQuery(filter: McpSessionFilter = {}, limit = 200) {
	return from(Traces)
		.select(issuedSessionColumns)
		.where(($) => sessionRequests($, filter))
		.groupBy("sessionId")
		.having(($) => [
			CH.when(filter.failingOnly === true ? true : undefined, () => CH.countIf(failedCall($)).gt(0)),
		])
		.orderBy(["lastSeen", "desc"])
		.limit(limit)
		.format("JSON")
}

/**
 * Totals over every request that belongs to a session, issued or a user's: the issued sessions, the
 * users and the tool calls. User sessions are counted by the backend once it has split them.
 */
export function mcpSessionTotalsQuery(filter: McpSessionFilter = {}) {
	return from(Traces)
		.select(($) => ({
			sessions: CH.uniqExact(CH.nullIf(sessionId($), "")),
			failingSessions: CH.uniqExact(CH.nullIf(CH.if_(failedCall($), sessionId($), CH.lit("")), "")),
			users: CH.uniqExact(CH.nullIf(userId($), "")),
			calls: CH.countIf(method($).eq("tools/call")),
			errors: CH.countIf(failedCall($)),
		}))
		.where(($) => [...serverSpans($), sessionId($).neq("").or(userId($).neq("")), ...selected($, filter)])
		.format("JSON")
}

const userMinuteColumns = ($: TracesRow) => ({
	user: userId($),
	client: mcpClientName($),
	minute: CH.toStartOfMinute($.Timestamp),
	kind: CH.any_(mcpClientKind($)),
	userName: nonEmpty(userLabel($)),
	requests: CH.count(),
	calls: CH.countIf(method($).eq("tools/call")),
	errors: CH.countIf(failedCall($)),
	tools: CH.groupUniqArray(CH.nullIf(toolName($), "")),
	firstSeen: CH.min_($.Timestamp),
	lastSeen: CH.max_($.Timestamp),
})

/**
 * A stateless server's known users, per (user, client, minute), the latest first so a limit drops the
 * oldest: the backend sorts them and splits each user and client's minutes into sessions at an idle gap.
 */
export function mcpUserActivityQuery(filter: McpSessionFilter = {}, limit = 50_000) {
	return from(Traces)
		.select(userMinuteColumns)
		.where(($) => userRequests($, filter))
		.groupBy("user", "client", "minute")
		.orderBy(["minute", "desc"])
		.limit(limit)
		.format("JSON")
}

/** The listed services' MCP server spans in the window. */
const serversSpans = ($: TracesRow, services: ReadonlyArray<string>) => [
	...inWindow($),
	services.length ? CH.inList($.ServiceName, services) : CH.rawCond("1 = 0"),
	method($).neq(""),
]

/** {@link mcpSessionListQuery} over several servers at once, keyed by (service, session). */
export function mcpServersSessionListQuery(
	services: ReadonlyArray<string>,
	filter: McpSessionFilter = {},
	limit = 200,
) {
	return from(Traces)
		.select(($) => ({ service: $.ServiceName, ...issuedSessionColumns($) }))
		.where(($) => [...serversSpans($, services), sessionId($).neq(""), ...selected($, filter)])
		.groupBy("service", "sessionId")
		.orderBy(["lastSeen", "desc"])
		.limit(limit)
		.format("JSON")
}

/** {@link mcpUserActivityQuery} over several servers at once, per (service, user, client, minute). */
/** Each listed server's newest `limitPerService` (user, client, minute) rows, so a quiet server keeps its own. */
export function mcpServersUserActivityQuery(
	services: ReadonlyArray<string>,
	filter: McpSessionFilter = {},
	limitPerService = 5_000,
) {
	const ranked = from(Traces)
		.select(($) => ({
			service: $.ServiceName,
			...userMinuteColumns($),
			serviceRank: CH.rawExpr(
				"row_number() OVER (PARTITION BY service ORDER BY minute DESC)",
				T.uint64,
			),
		}))
		.where(($) => [
			...serversSpans($, services),
			sessionId($).eq(""),
			userId($).neq(""),
			...selected($, filter),
		])
		.groupBy("service", "user", "client", "minute")
	return fromQuery(ranked, "ranked")
		.select(($) => ({
			service: $.service,
			user: $.user,
			client: $.client,
			minute: $.minute,
			kind: $.kind,
			userName: $.userName,
			requests: $.requests,
			calls: $.calls,
			errors: $.errors,
			tools: $.tools,
			firstSeen: $.firstSeen,
			lastSeen: $.lastSeen,
		}))
		.where(($) => [$.serviceRank.lte(limitPerService)])
		.orderBy(["minute", "desc"])
		.format("JSON")
}

/** Sessions and users active per bucket; a user's stateless requests count once per client. */
export function mcpSessionActivityQuery(filter: McpSessionFilter = {}) {
	return from(Traces)
		.select(($) => ({
			bucket: isoBucket($.Timestamp),
			sessions: CH.uniqExact(
				CH.if_(sessionId($).neq(""), sessionId($), CH.concat(userId($), "|", mcpClientName($))),
			),
			users: CH.uniqExact(CH.nullIf(userId($), "")),
		}))
		.where(($) => [...serverSpans($), sessionId($).neq("").or(userId($).neq("")), ...selected($, filter)])
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.format("JSON")
}

/** One request of a session, as the session page lists it. */
const requestColumns = ($: TracesRow) => ({
	timestamp: $.Timestamp,
	method: method($),
	tool: toolName($),
	client: mcpClientName($),
	kind: mcpClientKind($),
	user: userId($),
	userName: userLabel($),
	requestId: $.SpanAttributes.get("jsonrpc.request.id"),
	protocolVersion: $.SpanAttributes.get("mcp.protocol.version"),
	duration: $.Duration,
	errorType: errorType($),
	message: errorMessage($),
	traceId: $.TraceId,
	spanId: $.SpanId,
	linkTraceId: CH.arrayElement($.LinksTraceId, 1),
})

/**
 * One issued session's requests in order, every method. A caller that sent `params._meta` is the
 * span's own trace; the first link is the HTTP request's span, or the caller's on a server that only links.
 */
export function mcpSessionRequestsQuery(limit = 1_000) {
	return from(Traces)
		.select(requestColumns)
		.where(($) => [...serverSpans($), sessionId($).eq(param.string("sessionId"))])
		.orderBy(["timestamp", "asc"])
		.limit(limit)
		.format("JSON")
}

/** One user's stateless requests from one client in order; the session's own bounds are the window. */
export function mcpUserSessionRequestsQuery(limit = 1_000) {
	return from(Traces)
		.select(requestColumns)
		.where(($) => [
			...serverSpans($),
			sessionId($).eq(""),
			userId($).eq(param.string("userId")),
			mcpClientName($).eq(param.string("client")),
		])
		.orderBy(["timestamp", "asc"])
		.limit(limit)
		.format("JSON")
}
