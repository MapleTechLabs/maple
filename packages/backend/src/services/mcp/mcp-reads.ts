import {
	McpOverviewResponse,
	McpServersResponse,
	McpSessionResponse,
	McpSessionsResponse,
	McpToolResponse,
	type McpCallItem,
	type McpClientItem,
	type McpOverviewRequest,
	type McpSeriesPoint,
	type McpServersRequest,
	type McpSessionRequest,
	type McpSessionRequestItem,
	type McpSessionsRequest,
	type McpToolRequest,
} from "@maple/domain/http"
import { MCP_CLIENT_KINDS, UNKNOWN_MCP_CLIENT } from "@maple/domain/mcp-clients"
import { Array as Arr, DateTime, Effect } from "effect"
import { CH, formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"
import * as Integrations from "@maple/query-engine-integrations"
import { timestampMs } from "@maple/backend/platform/time"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"

// The MCP hub's reads: each page is one request fanning out, in parallel, to `ch/queries/mcp.ts`.

type Window = Readonly<{ startTime: string; endTime: string; bucketSeconds: number }>

const TOOLS_CALL = "tools/call"
/** Warehouse reads one page request runs at once; the rest queue behind them. */
const MCP_READ_CONCURRENCY = 4
/** A window never draws more buckets than this; a finer request is widened. */
const MAX_BUCKETS = 500

/** Epoch ms of a warehouse DateTime, `0` for the empty aggregate over no rows. */
const toMs = (value: DateTime.Utc): number => Math.max(0, DateTime.toEpochMillis(value))

/** The request's window with its bucket widened to at most {@link MAX_BUCKETS}, minute-aligned. */
const windowOf = (payload: Window): Window => {
	const span = (parseWarehouseDateTime(payload.endTime) - parseWarehouseDateTime(payload.startTime)) / 1000
	const floor = Math.ceil(Math.max(0, span) / MAX_BUCKETS / 60) * 60
	return {
		startTime: payload.startTime,
		endTime: payload.endTime,
		bucketSeconds: Math.max(payload.bucketSeconds, floor),
	}
}

/** The window's buckets, epoch-aligned like `toStartOfInterval`. */
const bucketsOf = (window: Window): ReadonlyArray<number> => {
	const step = window.bucketSeconds * 1000
	const first = Math.floor(parseWarehouseDateTime(window.startTime) / step) * step
	const end = parseWarehouseDateTime(window.endTime)
	return Array.from(
		{ length: Math.max(0, Math.floor((end - first) / step) + 1) },
		(_, i) => first + i * step,
	)
}

const sumBy = <A>(rows: ReadonlyArray<A>, read: (row: A) => number) =>
	rows.reduce((total, row) => total + read(row), 0)

type MergedRow = Readonly<{
	bucket: string
	calls: number
	errors: number
	p50: number
	p90: number
	p95: number
}>

/** The merged series over every bucket, zeros where nothing ran. */
const mergedSeries = (
	buckets: ReadonlyArray<number>,
	rows: ReadonlyArray<MergedRow>,
): ReadonlyArray<McpSeriesPoint> => {
	const byBucket = new Map(rows.map((row) => [timestampMs(row.bucket), row]))
	return buckets.map((bucket) => {
		const row = byBucket.get(bucket)
		return {
			bucket,
			seriesKey: "all",
			calls: row?.calls ?? 0,
			errors: row?.errors ?? 0,
			p50: row?.p50 ?? 0,
			p90: row?.p90 ?? 0,
			p95: row?.p95 ?? 0,
		}
	})
}

/** Calls and errors per key over every bucket, zeros where nothing ran. */
const splitSeries = (
	buckets: ReadonlyArray<number>,
	rows: ReadonlyArray<Readonly<{ bucket: string; key: string; calls: number; errors: number }>>,
): ReadonlyArray<McpSeriesPoint> =>
	Object.entries(Arr.groupBy(rows, (row) => row.key)).flatMap(([seriesKey, keyed]) => {
		const byBucket = new Map(keyed.map((row) => [timestampMs(row.bucket), row]))
		return buckets.map((bucket) => ({
			bucket,
			seriesKey,
			calls: byBucket.get(bucket)?.calls ?? 0,
			errors: byBucket.get(bucket)?.errors ?? 0,
			p50: 0,
			p90: 0,
			p95: 0,
		}))
	})

type ClientReach = Readonly<{
	client: string
	kind: string
	calls: number
	connects: number
	sources: number
	lastSeen: DateTime.Utc
}>

const kindOf = (value: string) => MCP_CLIENT_KINDS.find((kind) => kind === value) ?? "unknown"

/**
 * The reach rows the overview may list as connect-only: under the client and kind selection, and
 * none under a tool search or failing-only, which tool calls alone can match.
 */
export const quietClientsFor = (
	reach: ReadonlyArray<ClientReach>,
	selection: Readonly<{ client?: string; kind?: string; search?: string; failingOnly?: boolean }>,
): ReadonlyArray<ClientReach> =>
	selection.search !== undefined || selection.failingOnly === true
		? []
		: reach.filter(
				(row) =>
					(selection.client === undefined || row.client === selection.client) &&
					(selection.kind === undefined || row.kind === selection.kind),
			)

/**
 * Tool-call clients with their reach. `quiet` also lists the clients that connected but called
 * no tool, after the callers. A quiet row made no tool call and at least one connect, so a caller
 * past the calls read's limit, or a client that only listed tools, stays out.
 */
export const clientItems = (
	rows: ReadonlyArray<Readonly<{ client: string; kind: string; calls: number; errors: number }>>,
	reach: ReadonlyArray<ClientReach> = [],
	quiet: ReadonlyArray<ClientReach> = [],
): ReadonlyArray<McpClientItem> => {
	const reachOf = new Map(reach.map((row) => [row.client, row]))
	const callers = new Set(rows.map((row) => row.client))
	return [
		...rows.map((row) => {
			const seen = reachOf.get(row.client)
			return {
				name: row.client,
				kind: kindOf(row.kind),
				calls: row.calls,
				errors: row.errors,
				connects: seen?.connects ?? 0,
				sources: seen?.sources ?? 0,
				lastSeenMs: seen === undefined ? 0 : toMs(seen.lastSeen),
			}
		}),
		...quiet
			.filter((row) => row.calls === 0 && row.connects > 0 && !callers.has(row.client))
			.map((row) => ({
				name: row.client,
				kind: kindOf(row.kind),
				calls: 0,
				errors: 0,
				connects: row.connects,
				sources: row.sources,
				lastSeenMs: toMs(row.lastSeen),
			})),
	]
}

export const readMcpServers = Effect.fn("McpReads.servers")(function* (
	tenant: TenantContext,
	payload: McpServersRequest,
) {
	const warehouse = yield* WarehouseQueryService
	yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })
	const window = windowOf(payload)
	const params = { orgId: tenant.orgId, ...window }
	const services = yield* warehouse.compiledQuery(tenant, CH.compile(CH.mcpServicesQuery(), params), {
		profile: "list",
		context: "mcpServices",
	})
	const names = services.filter((row) => row.serverSpans > 0).map((row) => row.service)
	yield* Effect.annotateCurrentSpan({ "maple.mcp.servers": names.length })
	if (names.length === 0) return new McpServersResponse({ servers: [] })
	const [stats, sparks, clients] = yield* Effect.all(
		[
			warehouse.compiledQuery(tenant, CH.compile(CH.mcpServerStatsQuery(names), params), {
				profile: "aggregation",
				context: "mcpServerStats",
			}),
			warehouse.compiledQuery(tenant, CH.compile(CH.mcpServerSparkQuery(names), params), {
				profile: "aggregation",
				context: "mcpServerSpark",
			}),
			warehouse.compiledQuery(tenant, CH.compile(CH.mcpServerClientsQuery(names), params), {
				profile: "aggregation",
				context: "mcpServerClients",
			}),
		],
		{ concurrency: MCP_READ_CONCURRENCY },
	)
	const buckets = bucketsOf(window)
	const servers = stats
		.filter((row) => row.calls > 0)
		.map((row) => {
			const spark = new Map(
				sparks
					.filter((entry) => entry.service === row.service)
					.map((entry) => [timestampMs(entry.bucket), entry.calls]),
			)
			const top = clients
				.filter((entry) => entry.service === row.service)
				.reduce<Readonly<{ client: string; calls: number }>>(
					(best, entry) => (entry.calls > best.calls ? entry : best),
					{ client: "", calls: 0 },
				)
			return {
				service: row.service,
				protocolVersion: row.protocolVersion,
				calls: row.calls,
				errors: row.errors,
				p95: row.p95,
				tools: row.tools,
				topClient: top.client,
				topClientShare: top.calls / row.calls,
				lastCallMs: toMs(row.lastCall),
				spark: buckets.map((bucket) => spark.get(bucket) ?? 0),
			}
		})
		.sort((a, b) => b.calls - a.calls)
	return new McpServersResponse({ servers })
})

export const readMcpOverview = Effect.fn("McpReads.overview")(function* (
	tenant: TenantContext,
	payload: McpOverviewRequest,
) {
	const warehouse = yield* WarehouseQueryService
	yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.mcp.service": payload.service })
	const window = windowOf(payload)
	const params = { orgId: tenant.orgId, serviceName: payload.service, ...window }
	const filter: CH.McpCallFilter = {
		search: payload.search,
		client: payload.client,
		kind: payload.kind,
		failingOnly: payload.failingOnly,
	}
	const aggregate = { profile: "aggregation" } as const
	const [
		summary,
		initializers,
		methods,
		allClients,
		clients,
		totals,
		series,
		toolSeries,
		clientSeries,
		tools,
		toolErrors,
		allTotals,
		firstSeen,
		reach,
	] = yield* Effect.all(
		[
			warehouse.compiledQuery(tenant, CH.compile(CH.mcpSpanSummaryQuery(), params), {
				...aggregate,
				context: "mcpSpanSummary",
			}),
			warehouse.compiledQuery(tenant, CH.compile(CH.mcpInitializersQuery(), params), {
				...aggregate,
				context: "mcpInitializers",
			}),
			warehouse.compiledQuery(tenant, CH.compile(CH.mcpMethodsQuery(), params), {
				...aggregate,
				context: "mcpMethods",
			}),
			warehouse.compiledQuery(tenant, CH.compile(CH.mcpClientsQuery(), params), {
				...aggregate,
				context: "mcpAllClients",
			}),
			warehouse.compiledQuery(tenant, CH.compile(CH.mcpClientsQuery(filter), params), {
				...aggregate,
				context: "mcpClients",
			}),
			warehouse.compiledQuery(tenant, CH.compile(CH.mcpCallTotalsQuery(filter), params), {
				...aggregate,
				context: "mcpCallTotals",
			}),
			warehouse.compiledQuery(tenant, CH.compile(CH.mcpCallSeriesQuery(filter), params), {
				...aggregate,
				context: "mcpCallSeries",
			}),
			warehouse.compiledQuery(tenant, CH.compile(CH.mcpCallSplitSeriesQuery("tool", filter), params), {
				...aggregate,
				context: "mcpToolSeries",
			}),
			warehouse.compiledQuery(
				tenant,
				CH.compile(CH.mcpCallSplitSeriesQuery("client", filter), params),
				{
					...aggregate,
					context: "mcpClientSeries",
				},
			),
			warehouse.compiledQuery(tenant, CH.compile(CH.mcpToolStatsQuery(filter), params), {
				...aggregate,
				context: "mcpToolStats",
			}),
			warehouse.compiledQuery(tenant, CH.compile(CH.mcpToolErrorsQuery(filter), params), {
				...aggregate,
				context: "mcpToolErrors",
			}),
			warehouse.compiledQuery(tenant, CH.compile(CH.mcpCallTotalsQuery(), params), {
				...aggregate,
				context: "mcpAllTotals",
			}),
			warehouse.compiledQuery(tenant, CH.compile(CH.mcpFirstSeenQuery(), params), {
				profile: "list",
				context: "mcpFirstSeen",
			}),
			warehouse.compiledQuery(tenant, CH.compile(CH.mcpClientReachQuery(), params), {
				...aggregate,
				context: "mcpClientReach",
			}),
		],
		{ concurrency: MCP_READ_CONCURRENCY },
	)
	// A tool search or failing-only selection matches tool calls alone, so it hides quiet clients.
	const quiet = quietClientsFor(reach, payload)
	const buckets = bucketsOf(window)
	const sparks = Arr.groupBy(toolSeries, (row) => row.key)
	const calls = summary.filter((row) => row.method === TOOLS_CALL)
	const failedCalls = calls.filter((row) => row.errorType !== "")
	const firstSpans = summary.map((row) => toMs(row.firstSpan)).filter((ms) => ms > 0)
	const firstInWindow = firstSpans.length === 0 ? 0 : Math.min(...firstSpans)
	// The rollup knows calls before the window; within it, the window's own first span is exact.
	const firstHour = toMs(firstSeen[0]?.firstHour ?? DateTime.makeUnsafe(0))
	const firstSpanMs =
		firstHour > 0 && firstHour < parseWarehouseDateTime(window.startTime) ? firstHour : firstInWindow
	// Rows arrive most frequent first, so a tool's first row is its top error.
	const topErrors = new Map<string, string>()
	toolErrors.forEach((row) => {
		if (!topErrors.has(row.tool)) topErrors.set(row.tool, row.errorType)
	})
	const protocolVersion = summary.find((row) => row.protocolVersion !== "")?.protocolVersion ?? ""
	const transport = summary.find((row) => row.transport !== "")?.transport ?? ""
	const failures = Arr.groupBy(toolErrors, (row) => row.errorType)
	const total = totals[0]
	return new McpOverviewResponse({
		service: payload.service,
		protocolVersion,
		transport,
		firstSpanMs,
		toolCount: allTotals[0]?.tools ?? 0,
		series: mergedSeries(buckets, series),
		clientSeries: splitSeries(buckets, clientSeries),
		totals: {
			calls: total?.calls ?? 0,
			errors: total?.errors ?? 0,
			statusErrors: total?.statusErrors ?? 0,
			p50: total?.p50 ?? 0,
			p90: total?.p90 ?? 0,
			p95: total?.p95 ?? 0,
		},
		tools: tools.map((row) => {
			const spark = new Map(
				(sparks[row.tool] ?? []).map((entry) => [timestampMs(entry.bucket), entry.calls]),
			)
			return {
				tool: row.tool,
				calls: row.calls,
				errors: row.errors,
				p50: row.p50,
				p90: row.p90,
				p95: row.p95,
				topError: topErrors.get(row.tool) ?? null,
				lastCallMs: toMs(row.lastCall),
				spark: buckets.map((bucket) => spark.get(bucket) ?? 0),
			}
		}),
		clients: clientItems(clients, reach, quiet),
		allClients: clientItems(allClients, reach),
		initializers,
		failures: Object.entries(failures)
			.map(([errorType, rows]) => ({ errorType, count: sumBy(rows, (row) => row.count) }))
			.sort((a, b) => b.count - a.count),
		methods: methods.map((row) => ({ method: row.method, calls: row.calls, p50: row.p50, p95: row.p95 })),
		coverage: {
			toolCalls: sumBy(calls, (row) => row.spans),
			withToolName: sumBy(calls, (row) => row.withToolName),
			withUserAgent: sumBy(calls, (row) => row.withUserAgent),
			toolErrors: sumBy(failedCalls, (row) => row.spans),
			errorsWithMessage: sumBy(failedCalls, (row) => row.withMessage),
			withSession: sumBy(calls, (row) => row.withSession),
			withCallerTrace: sumBy(calls, (row) => row.withCallerTrace),
			protocolVersion,
			transport,
		},
	})
})

export const readMcpTool = Effect.fn("McpReads.tool")(function* (
	tenant: TenantContext,
	payload: McpToolRequest,
) {
	const warehouse = yield* WarehouseQueryService
	yield* Effect.annotateCurrentSpan({
		orgId: tenant.orgId,
		"maple.mcp.service": payload.service,
		"maple.mcp.tool": payload.tool,
	})
	const window = windowOf(payload)
	const params = { orgId: tenant.orgId, serviceName: payload.service, ...window }
	const filter: CH.McpCallFilter = {
		tool: payload.tool,
		client: payload.client,
		kind: payload.kind,
		failingOnly: payload.failingOnly,
	}
	const aggregate = { profile: "aggregation" } as const
	const list = (order: CH.McpCallOrder) =>
		warehouse.compiledQuery(tenant, CH.compile(CH.mcpCallListQuery(order, filter), params), {
			profile: "list",
			context: `mcpCalls.${order}`,
		})
	const [allClients, clients, totals, series, clientSeries, groups, slowest, failed, recent] =
		yield* Effect.all(
			[
				warehouse.compiledQuery(
					tenant,
					CH.compile(CH.mcpClientsQuery({ tool: payload.tool }), params),
					{
						...aggregate,
						context: "mcpToolAllClients",
					},
				),
				warehouse.compiledQuery(tenant, CH.compile(CH.mcpClientsQuery(filter), params), {
					...aggregate,
					context: "mcpToolClients",
				}),
				warehouse.compiledQuery(tenant, CH.compile(CH.mcpCallTotalsQuery(filter), params), {
					...aggregate,
					context: "mcpToolTotals",
				}),
				warehouse.compiledQuery(tenant, CH.compile(CH.mcpCallSeriesQuery(filter), params), {
					...aggregate,
					context: "mcpToolCallSeries",
				}),
				warehouse.compiledQuery(
					tenant,
					CH.compile(CH.mcpCallSplitSeriesQuery("client", filter), params),
					{
						...aggregate,
						context: "mcpToolClientSeries",
					},
				),
				warehouse.compiledQuery(tenant, CH.compile(CH.mcpErrorGroupsQuery(filter), params), {
					...aggregate,
					context: "mcpErrorGroups",
				}),
				list("slowest"),
				list("failed"),
				list("recent"),
			],
			{ concurrency: MCP_READ_CONCURRENCY },
		)
	// The trends read only the groups the panel lists.
	const trend =
		groups.length === 0
			? []
			: yield* warehouse.compiledQuery(
					tenant,
					CH.compile(
						CH.mcpErrorTrendQuery(
							filter,
							groups.map((group) => group.message),
						),
						params,
					),
					{ ...aggregate, context: "mcpErrorTrend" },
				)
	const buckets = bucketsOf(window)
	const callItem = (row: (typeof slowest)[number]): McpCallItem => ({
		timeMs: toMs(row.timestamp),
		client: row.client,
		requestId: row.requestId,
		durationNs: row.duration,
		errorType: row.errorType === "" ? null : row.errorType,
		traceId: row.traceId,
		spanId: row.spanId,
	})
	const total = totals[0]
	const hasCalls = total !== undefined && total.calls > 0
	return new McpToolResponse({
		service: payload.service,
		tool: payload.tool,
		calls: total?.calls ?? 0,
		errors: total?.errors ?? 0,
		clients: clients.length,
		firstCallMs: hasCalls ? toMs(total.firstCall) : 0,
		lastCallMs: hasCalls ? toMs(total.lastCall) : 0,
		series: mergedSeries(buckets, series),
		clientSeries: splitSeries(buckets, clientSeries),
		allClients: clientItems(allClients),
		errorGroups: groups.map((group) => {
			const counts = new Map(
				trend
					.filter((row) => row.errorType === group.errorType && row.message === group.message)
					.map((row) => [timestampMs(row.bucket), row.count]),
			)
			return {
				errorType: group.errorType,
				message: group.message === "" ? null : group.message,
				count: group.count,
				clients: group.clients,
				lastSeenMs: toMs(group.lastSeen),
				trend: buckets.map((bucket) => counts.get(bucket) ?? 0),
			}
		}),
		slowest: slowest.map(callItem),
		failed: failed.map(callItem),
		recent: recent.map(callItem),
	})
})

/** Sessions the list reads at most. */
const SESSION_LIST_LIMIT = 200
/** Requests the session page reads at most; one more tells it the session was cut. */
const SESSION_REQUEST_LIMIT = 1_000
/** An agent turn can start this long before its first MCP call, and only its first spans may name the session. */
const AGENT_TURN_LEAD_MS = 3_600_000

export const readMcpSessions = Effect.fn("McpReads.sessions")(function* (
	tenant: TenantContext,
	payload: McpSessionsRequest,
) {
	const warehouse = yield* WarehouseQueryService
	yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.mcp.service": payload.service })
	const window = windowOf(payload)
	const params = { orgId: tenant.orgId, serviceName: payload.service, ...window }
	const selection: CH.McpSessionFilter = {
		client: payload.client,
		kind: payload.kind,
		search: payload.search,
	}
	const aggregate = { profile: "aggregation" } as const
	const [summary, allClients, totals, sessions] = yield* Effect.all(
		[
			warehouse.compiledQuery(tenant, CH.compile(CH.mcpSpanSummaryQuery(), params), {
				...aggregate,
				context: "mcpSessionCoverage",
			}),
			warehouse.compiledQuery(tenant, CH.compile(CH.mcpClientsQuery(), params), {
				...aggregate,
				context: "mcpSessionClients",
			}),
			warehouse.compiledQuery(tenant, CH.compile(CH.mcpSessionTotalsQuery(selection), params), {
				...aggregate,
				context: "mcpSessionTotals",
			}),
			warehouse.compiledQuery(
				tenant,
				CH.compile(
					CH.mcpSessionListQuery(
						{ ...selection, failingOnly: payload.failingOnly },
						SESSION_LIST_LIMIT,
					),
					params,
				),
				{ ...aggregate, context: "mcpSessionList" },
			),
		],
		{ concurrency: MCP_READ_CONCURRENCY },
	)
	const calls = summary.filter((row) => row.method === TOOLS_CALL)
	const total = totals[0]
	yield* Effect.annotateCurrentSpan({ "maple.mcp.sessions": total?.sessions ?? 0 })
	return new McpSessionsResponse({
		service: payload.service,
		totals: {
			sessions: total?.sessions ?? 0,
			failingSessions: total?.failingSessions ?? 0,
			calls: total?.calls ?? 0,
			errors: total?.errors ?? 0,
		},
		toolCalls: sumBy(calls, (row) => row.spans),
		withSession: sumBy(calls, (row) => row.withSession),
		sessions: sessions.map((row) => ({
			sessionId: row.sessionId,
			client: row.client === "" ? UNKNOWN_MCP_CLIENT : row.client,
			kind: kindOf(row.kind),
			requests: row.requests,
			calls: row.calls,
			errors: row.errors,
			tools: row.tools,
			firstSeenMs: toMs(row.firstSeen),
			lastSeenMs: toMs(row.lastSeen),
		})),
		allClients: clientItems(allClients),
	})
})

type SessionRow = Readonly<{ traceId: string; linkTraceId: string }>

/** Each request's caller traces, its own first: `params._meta` parents the span, a link is the fallback. */
const callerTraces = (row: SessionRow): ReadonlyArray<string> =>
	[row.traceId, row.linkTraceId].filter((id) => id !== "")

/** The Agent Session of each request: the first of its caller traces that one is filed under. */
export const agentSessionsOf = (
	rows: ReadonlyArray<SessionRow>,
	filed: ReadonlyArray<Readonly<{ traceId: string; sessionId: string }>>,
): ReadonlyArray<string | null> => {
	const sessionOf = new Map(filed.map((row) => [row.traceId, row.sessionId]))
	return rows.map((row) => callerTraces(row).flatMap((id) => sessionOf.get(id) ?? [])[0] ?? null)
}

export const readMcpSession = Effect.fn("McpReads.session")(function* (
	tenant: TenantContext,
	payload: McpSessionRequest,
) {
	const warehouse = yield* WarehouseQueryService
	yield* Effect.annotateCurrentSpan({
		orgId: tenant.orgId,
		"maple.mcp.service": payload.service,
		"maple.mcp.session.id": payload.sessionId,
	})
	const window = windowOf(payload)
	const params = {
		orgId: tenant.orgId,
		serviceName: payload.service,
		sessionId: payload.sessionId,
		...window,
	}
	const read = yield* warehouse.compiledQuery(
		tenant,
		CH.compile(CH.mcpSessionRequestsQuery(SESSION_REQUEST_LIMIT + 1), params),
		{ profile: "list", context: "mcpSessionRequests" },
	)
	const rows = read.slice(0, SESSION_REQUEST_LIMIT)
	const traceIds = [...new Set(rows.flatMap(callerTraces))]
	const filed =
		traceIds.length === 0
			? []
			: yield* warehouse.compiledQuery(
					tenant,
					CH.compile(Integrations.aiSessionsOfTracesQuery(traceIds), {
						orgId: tenant.orgId,
						startTime: formatWarehouseDateTime(
							parseWarehouseDateTime(window.startTime) - AGENT_TURN_LEAD_MS,
						),
						endTime: window.endTime,
					}),
					{ profile: "list", context: "mcpSessionAgentSessions" },
				)
	const agentSessions = agentSessionsOf(rows, filed)
	const named = rows.find((row) => row.client !== UNKNOWN_MCP_CLIENT)
	yield* Effect.annotateCurrentSpan({
		"maple.mcp.session.requests": rows.length,
		"maple.mcp.session.agent_sessions": new Set(agentSessions.filter((id) => id !== null)).size,
	})
	return new McpSessionResponse({
		service: payload.service,
		sessionId: payload.sessionId,
		client: named?.client ?? UNKNOWN_MCP_CLIENT,
		kind: kindOf(named?.kind ?? "unknown"),
		protocolVersion: rows.find((row) => row.protocolVersion !== "")?.protocolVersion ?? "",
		requests: rows.map((row, index): McpSessionRequestItem => ({
			timeMs: toMs(row.timestamp),
			method: row.method,
			tool: row.tool === "" ? null : row.tool,
			requestId: row.requestId,
			durationNs: row.duration,
			errorType: row.errorType === "" ? null : row.errorType,
			message: row.message === "" ? null : row.message,
			traceId: row.traceId,
			spanId: row.spanId,
			agentSessionId: agentSessions[index] ?? null,
		})),
		isTruncated: read.length > SESSION_REQUEST_LIMIT,
	})
})
