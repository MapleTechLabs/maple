import {
	McpOverviewResponse,
	McpServersResponse,
	McpToolResponse,
	type McpCallItem,
	type McpClientItem,
	type McpOverviewRequest,
	type McpSeriesPoint,
	type McpServersRequest,
	type McpToolRequest,
} from "@maple/domain/http"
import { MCP_CLIENT_KINDS } from "@maple/domain/mcp-clients"
import { Array as Arr, DateTime, Effect } from "effect"
import { CH, parseWarehouseDateTime } from "@maple/query-engine"
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

const clientItems = (
	rows: ReadonlyArray<Readonly<{ client: string; kind: string; calls: number; errors: number }>>,
): ReadonlyArray<McpClientItem> =>
	rows.map((row) => ({
		name: row.client,
		kind: MCP_CLIENT_KINDS.find((kind) => kind === row.kind) ?? "unknown",
		calls: row.calls,
		errors: row.errors,
	}))

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
		],
		{ concurrency: MCP_READ_CONCURRENCY },
	)
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
		clients: clientItems(clients),
		allClients: clientItems(allClients),
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
