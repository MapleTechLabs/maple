import type {
	McpSessionItem,
	McpSessionRequestItem,
	McpSessionResponse,
	McpSessionsResponse,
} from "@maple/domain/http"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { formatLatency, formatNumber, pluralize } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { formatDurationNs } from "@maple/web-data/lib/tool-analytics"
import type { Html, HtmlBuilder } from "foldkit/html"
import { emptyMessage } from "@maple/views/ui/empty"
import { icon } from "@maple/views/ui/icon"
import { pressable } from "@maple/views/ui/pressable"
import { ROW_LINK_LIFT, rowLink } from "@maple/views/ui/table"
import {
	shareCell,
	th,
	toolTableRow,
	toolTable,
	toolTableBody,
	toolTableFooter,
	toolTableHead,
} from "../agent-sessions/tools-kit/table"
import { filteredEmpty } from "@maple/views/ui/signal-empty-state"
import { statRail, statRailItem } from "../kit/stat-rail"
import {
	attr,
	clientIcon,
	durationMeterCell,
	formatClock,
	headingNote,
	kindTag,
	lastSeenCell,
	type McpChartEnv,
	mcpPlot,
	mcpScopeRow,
	numberCell,
	resultCell,
	sectionTitle,
	RESULT_LANE,
} from "./view-kit"
import { Array as Arr, Order } from "effect"

// `/mcp-servers/:service/sessions` and one session: a server's requests grouped by `mcp.session.id`,
// each session its requests in order, linked to the Agent Session whose trace made them.

export type SessionsBodyOptions<M> = Readonly<{
	env: McpChartEnv<M>
	toolbar: Html
	scope: string
	isWaiting: boolean
	isFailingOnly: boolean
	/** A session's page; the row is a link to it. */
	sessionHref: (sessionId: string) => string
	/** The end user's page, for a session that names one. */
	userHref: (userId: string) => string
	nowMs: number
	timeZone: string
}>

const arrowCell = <M>(h: HtmlBuilder<M>): Html =>
	h.span(
		[h.Class("flex w-3.5 shrink-0 items-center justify-end text-foreground-subtle")],
		[icon(h, "ArrowRightIcon", { size: 14 })],
	)

const failedCell = <M>(h: HtmlBuilder<M>, errors: number): Html =>
	numberCell(
		h,
		formatNumber(errors),
		cn("w-14", errors > 0 ? "text-severity-error" : "text-foreground-subtle"),
	)

const USER_CELL = "hidden w-36 shrink-0 truncate font-mono text-xs @min-[950px]/panel:block"

/** Who the session belongs to: their name, else their id, linked to their user page; else nobody named. */
/** Who a session's row names: `user.name`/`user.email`, else the id, else `anonymous`. */
export const sessionUserLabel = (user: string | null, userName: string | null): string =>
	userName ?? user ?? "anonymous"

const userCell = <M>(
	h: HtmlBuilder<M>,
	user: string | null,
	userName: string | null,
	userHref: (userId: string) => string,
): Html =>
	user === null
		? h.span([h.Class(cn(USER_CELL, "text-foreground-subtle"))], [sessionUserLabel(user, userName)])
		: h.a(
				[
					h.Href(userHref(user)),
					h.Title(`Open user ${user}`),
					h.Class(cn(USER_CELL, ROW_LINK_LIFT, "text-foreground hover:underline active:underline")),
				],
				[sessionUserLabel(user, userName)],
			)

const sessionRow = <M>(h: HtmlBuilder<M>, row: McpSessionItem, options: SessionsBodyOptions<M>): Html =>
	toolTableRow(h, { className: "relative", attributes: [h.Key(row.sessionId)] }, [
		rowLink(h, { href: options.sessionHref(row.sessionId), label: `Open session ${row.sessionId}` }),
		row.source === "issued"
			? h.span(
					[h.Class("w-0 min-w-0 flex-1 truncate font-mono text-xs text-foreground")],
					[row.sessionId],
				)
			: // Who it was only while the User column is hidden in a narrow panel.
				h.span(
					[h.Class("flex w-0 min-w-0 flex-1 items-baseline gap-2 font-mono text-xs")],
					[
						h.span(
							[h.Class("truncate text-foreground @min-[950px]/panel:hidden")],
							[sessionUserLabel(row.user, row.userName)],
						),
						h.span([h.Class("shrink-0 text-2xs text-foreground-subtle")], ["user session"]),
					],
				),
		userCell(h, row.user, row.userName, options.userHref),
		h.span(
			[h.Class("flex w-44 shrink-0 items-center gap-2 font-mono text-xs")],
			[
				clientIcon(h, row.client, 12),
				h.span([h.Class("truncate")], [row.client]),
				...kindTag(h, row.kind),
			],
		),
		numberCell(h, formatNumber(row.calls), "w-14"),
		failedCell(h, row.errors),
		numberCell(h, formatNumber(row.tools), "hidden w-14 text-muted-foreground @min-[800px]/panel:block"),
		numberCell(
			h,
			formatLatency(row.lastSeenMs - row.firstSeenMs),
			"hidden w-20 text-muted-foreground @min-[560px]/panel:block",
		),
		numberCell(h, formatClock(row.firstSeenMs, options.timeZone), "w-16 text-muted-foreground"),
		lastSeenCell(h, row.lastSeenMs, options.nowMs, options.timeZone),
		arrowCell(h),
	])

/** The read of users' activity hit its limit, so older user sessions are missing or cut short. */
const activityCut = <M>(h: HtmlBuilder<M>, data: McpSessionsResponse): ReadonlyArray<Html> =>
	data.isUserActivityCut
		? [
				h.p(
					[h.Class("px-2.5 pt-3 font-prose text-xs text-muted-foreground")],
					[
						"This window has more user activity than one read holds: the oldest user sessions are missing or cut short. Narrow the time range to see them.",
					],
				),
			]
		: []

/** The calls in no session: neither a session id nor a user to build one from. */
const partialCoverage = <M>(h: HtmlBuilder<M>, data: McpSessionsResponse): ReadonlyArray<Html> => {
	const inSessions = data.inSession
	return inSessions >= data.toolCalls
		? []
		: [
				h.p(
					[h.Class("px-2.5 pt-3 font-prose text-xs text-muted-foreground")],
					[
						`${formatNumber(data.toolCalls - inSessions)} of ${formatNumber(data.toolCalls)} tool calls carry neither `,
						attr(h, "mcp.session.id"),
						" nor ",
						attr(h, "user.id"),
						", so they belong to no session.",
					],
				),
			]
}

/** The median of the listed sessions' lengths; `undefined` for none. */
export const medianLengthMs = (sessions: ReadonlyArray<McpSessionItem>): number | undefined => {
	const lengths = Arr.sort(
		Arr.map(sessions, (row) => row.lastSeenMs - row.firstSeenMs),
		Order.Number,
	)
	const middle = Math.floor(lengths.length / 2)
	return lengths.length === 0
		? undefined
		: lengths.length % 2 === 1
			? lengths[middle]
			: ((lengths[middle - 1] ?? 0) + (lengths[middle] ?? 0)) / 2
}

const sessionsOverview = <M>(
	h: HtmlBuilder<M>,
	data: McpSessionsResponse,
	options: SessionsBodyOptions<M>,
): ReadonlyArray<Html> => {
	const { totals } = data
	const median = medianLengthMs(data.sessions)
	return [
		statRail(h, { columns: 4, isFlush: true }, [
			statRailItem(h, {
				eyebrow: "Sessions",
				value: formatNumber(totals.sessions),
				subline: `${formatNumber(totals.failingSessions)} with a failed call`,
			}),
			statRailItem(h, {
				eyebrow: "Users",
				value: formatNumber(totals.users),
				subline: totals.users === 0 ? "no request names its user" : "from user.id",
			}),
			statRailItem(h, {
				eyebrow: "Median length",
				value: median === undefined ? "–" : formatLatency(median),
				subline:
					data.sessions.length === 0
						? undefined
						: `of the latest ${formatNumber(data.sessions.length)}`,
			}),
			statRailItem(h, {
				eyebrow: "Calls a session",
				value: totals.sessions === 0 ? "–" : (totals.calls / totals.sessions).toFixed(1),
				subline: `${formatNumber(totals.calls)} tool calls`,
			}),
		]),
		mcpPlot(h, options.env, {
			chartId: "mcp-sessions-activity",
			title: "Active sessions and users",
			rows: Arr.map(data.activity, (point) => ({
				bucket: formatWarehouseDateTime(point.bucket),
				sessions: point.sessions,
				users: point.users,
			})),
			series: [
				{ key: "sessions", label: "Sessions", token: "--primary" },
				{ key: "users", label: "Users", token: "--chart-2" },
			],
			format: "number",
			height: 180,
		}),
	]
}

/** `McpSessionsBody`: the sessions list under the server header. */
export const sessionsBody = <M>(
	h: HtmlBuilder<M>,
	data: McpSessionsResponse,
	options: SessionsBodyOptions<M>,
): Html => {
	const { totals } = data
	const matching = options.isFailingOnly ? totals.failingSessions : totals.sessions
	return h.div(
		[h.Class("flex flex-col")],
		[
			options.toolbar,
			mcpScopeRow(
				h,
				options.scope,
				formatNumber(totals.sessions),
				`${pluralize(totals.sessions, "session")} · ${formatNumber(totals.users)} ${pluralize(totals.users, "user")}`,
			),
			...sessionsOverview(h, data, options),
			h.section(
				[h.AriaLabel("Sessions"), h.Class("@container/panel min-w-0 px-6 pt-6 pb-6")],
				[
					sectionTitle(h, "Sessions", formatNumber(data.sessions.length)),
					toolTable(h, [
						toolTableHead(h, [
							th(h, { label: "Session", width: "w-0 flex-1 min-w-0" }),
							th(h, {
								label: "User",
								width: "w-36 shrink-0",
								hidden: "hidden @min-[950px]/panel:flex",
							}),
							th(h, { label: "Client", width: "w-44 shrink-0" }),
							th(h, { label: "Calls", width: "w-14 shrink-0", align: "right" }),
							th(h, { label: "Failed", width: "w-14 shrink-0", align: "right" }),
							th(h, {
								label: "Tools",
								width: "w-14 shrink-0",
								align: "right",
								hidden: "hidden @min-[800px]/panel:flex",
							}),
							th(h, {
								label: "Length",
								width: "w-20 shrink-0",
								align: "right",
								hidden: "hidden @min-[560px]/panel:flex",
							}),
							th(h, { label: "Started", width: "w-16 shrink-0", align: "right" }),
							th(h, {
								label: "Last seen",
								width: "w-24 shrink-0",
								align: "right",
								hidden: "hidden @min-[800px]/panel:flex",
							}),
							h.span([h.AriaHidden(true), h.Class("w-3.5 shrink-0")], []),
						]),
						toolTableBody(
							h,
							data.sessions.length === 0
								? [
										filteredEmpty(h, {
											noun: "sessions",
											description: "",
											className: "py-10 md:py-12",
										}),
									]
								: Arr.map(data.sessions, (row) => sessionRow(h, row, options)),
							{ isWaiting: options.isWaiting },
						),
					]),
					toolTableFooter(
						h,
						`${formatNumber(data.sessions.length)} latest of ${formatNumber(matching)}`,
						"· each row opens the session",
					),
					...activityCut(h, data),
					...partialCoverage(h, data),
				],
			),
		],
	)
}

export type SessionBodyOptions<M> = Readonly<{
	onOpenTrace: (traceId: string) => M
	onOpenAgentSession: (sessionId: string) => M
	onOpenTool: (tool: string) => M
	timeZone: string
}>

/** The session's tool calls, its other requests (`initialize`, `tools/list`) left out. */
export const sessionCalls = (
	requests: ReadonlyArray<McpSessionRequestItem>,
): ReadonlyArray<McpSessionRequestItem> => Arr.filter(requests, (row) => row.method === "tools/call")

/** First request to last, as the sessions list measures it. */
export const sessionLengthMs = (requests: ReadonlyArray<McpSessionRequestItem>): number =>
	(requests.at(-1)?.timeMs ?? 0) - (requests[0]?.timeMs ?? 0)

/** The Agent Sessions behind the requests, the most requests first. */
export const linkedAgentSessions = (
	requests: ReadonlyArray<McpSessionRequestItem>,
): ReadonlyArray<Readonly<{ sessionId: string; requests: number }>> => {
	const counts = new Map<string, number>()
	Arr.forEach(requests, (row) => {
		if (row.agentSessionId !== null)
			counts.set(row.agentSessionId, (counts.get(row.agentSessionId) ?? 0) + 1)
	})
	return Arr.map([...counts], ([sessionId, count]) => ({ sessionId, requests: count })).sort(
		(a, b) => b.requests - a.requests,
	)
}

/** Per tool across the session's calls: calls, failures and the time spent in it. `null` is a call naming no tool. */
export const sessionToolsOf = (
	requests: ReadonlyArray<McpSessionRequestItem>,
): ReadonlyArray<Readonly<{ tool: string | null; calls: number; errors: number; durationNs: number }>> => {
	const tools = new Map<string | null, { calls: number; errors: number; durationNs: number }>()
	Arr.forEach(sessionCalls(requests), (row) => {
		const entry = tools.get(row.tool) ?? { calls: 0, errors: 0, durationNs: 0 }
		tools.set(row.tool, {
			calls: entry.calls + 1,
			errors: entry.errors + (row.errorType === null ? 0 : 1),
			durationNs: entry.durationNs + row.durationNs,
		})
	})
	return Arr.map([...tools], ([tool, entry]) => ({ tool, ...entry })).sort((a, b) => b.calls - a.calls)
}

/** `+1.2s` from the session's first request; the first reads `start`. */
const offsetLabel = (ms: number): string => (ms <= 0 ? "start" : `+${formatLatency(ms)}`)

const requestRow = <M>(
	h: HtmlBuilder<M>,
	row: McpSessionRequestItem,
	context: Readonly<{ startMs: number; max: number; options: SessionBodyOptions<M> }>,
): Html =>
	toolTableRow(h, { onClick: context.options.onOpenTrace(row.traceId), attributes: [h.Key(row.spanId)] }, [
		numberCell(h, offsetLabel(row.timeMs - context.startMs), "w-20 text-left text-muted-foreground"),
		h.span(
			[h.Class("flex w-0 min-w-0 flex-1 items-baseline gap-2 font-mono text-xs")],
			row.method === "tools/call" && row.tool !== null
				? [
						h.span([h.Class("truncate text-foreground")], [row.tool]),
						h.span([h.Class("shrink-0 text-2xs text-foreground-subtle")], ["tools/call"]),
					]
				: [h.span([h.Class("truncate text-muted-foreground")], [row.method])],
		),
		h.span(
			[
				h.Class(
					"hidden w-0 min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground @min-[800px]/panel:block",
				),
			],
			[row.message ?? ""],
		),
		durationMeterCell(h, {
			durationNs: row.durationNs,
			max: context.max,
			isFailed: row.errorType !== null,
		}),
		resultCell(h, row.errorType),
		numberCell(
			h,
			formatClock(row.timeMs, context.options.timeZone),
			"hidden w-14 text-foreground-subtle @min-[640px]/panel:block",
		),
		arrowCell(h),
	])

const agentSessionsPanel = <M>(
	h: HtmlBuilder<M>,
	data: McpSessionResponse,
	options: SessionBodyOptions<M>,
): Html => {
	const linked = linkedAgentSessions(data.requests)
	return h.section(
		[h.AriaLabel("Agent sessions"), h.Class("min-w-0 px-6 pt-6")],
		[
			sectionTitle(h, "Agent sessions", formatNumber(linked.length)),
			linked.length === 0
				? h.p(
						[h.Class("font-prose text-xs text-muted-foreground")],
						[
							"No request carried an agent's trace. A client that sends its trace context in ",
							attr(h, "params._meta"),
							" links each call to the Agent Session that made it.",
						],
					)
				: h.div(
						[h.Class("flex flex-wrap gap-2")],
						Arr.map(linked, (entry) =>
							pressable(
								h,
								{
									onClick: options.onOpenAgentSession(entry.sessionId),
									className:
										"inline-flex max-w-full items-center gap-2 rounded-md border border-border px-2.5 py-1.5 font-mono text-xs hover:bg-surface-sunken active:bg-surface-sunken",
									attributes: [h.Key(entry.sessionId)],
								},
								[
									icon(h, "SquareSparkleIcon", {
										size: 12,
										className: "shrink-0 text-muted-foreground",
									}),
									h.span([h.Class("truncate text-foreground")], [entry.sessionId]),
									h.span(
										[h.Class("shrink-0 text-2xs tabular-nums text-foreground-subtle")],
										[
											`${formatNumber(entry.requests)} ${pluralize(entry.requests, "request")}`,
										],
									),
									icon(h, "ArrowRightIcon", {
										size: 12,
										className: "shrink-0 text-foreground-subtle",
									}),
								],
							),
						),
					),
		],
	)
}

const toolRow = <M>(
	h: HtmlBuilder<M>,
	tool: ReturnType<typeof sessionToolsOf>[number],
	max: number,
	options: SessionBodyOptions<M>,
): Html => {
	const cells = [
		h.span(
			[
				h.Class(
					cn(
						"w-0 min-w-0 flex-1 truncate font-mono text-xs",
						tool.tool === null && "text-muted-foreground",
					),
				),
			],
			[tool.tool ?? "no tool name"],
		),
		shareCell(h, {
			ratio: tool.calls,
			max,
			label: formatNumber(tool.calls),
			tone: { bar: "bg-primary", text: "text-foreground" },
		}),
		failedCell(h, tool.errors),
		numberCell(h, formatDurationNs(tool.durationNs), "w-20 text-muted-foreground"),
	]
	// A call naming no tool has no tool page to open.
	return tool.tool === null
		? toolTableRow(h, { attributes: [h.Key("no-tool-name")] }, [
				...cells,
				h.span([h.Class("w-3.5 shrink-0")], []),
			])
		: toolTableRow(h, { onClick: options.onOpenTool(tool.tool), attributes: [h.Key(tool.tool)] }, [
				...cells,
				arrowCell(h),
			])
}

const toolsPanel = <M>(h: HtmlBuilder<M>, data: McpSessionResponse, options: SessionBodyOptions<M>): Html => {
	const tools = sessionToolsOf(data.requests)
	const max = Math.max(...Arr.map(tools, (tool) => tool.calls), 1)
	return h.section(
		[h.AriaLabel("Tools"), h.Class("@container/panel min-w-0 px-6 pt-6")],
		[
			sectionTitle(h, "Tools", formatNumber(tools.length)),
			toolTable(h, [
				toolTableHead(h, [
					th(h, { label: "Tool", width: "w-0 flex-1 min-w-0" }),
					th(h, { label: "Calls", width: "w-36 shrink-0", align: "right" }),
					th(h, { label: "Failed", width: "w-14 shrink-0", align: "right" }),
					th(h, { label: "Time", width: "w-20 shrink-0", align: "right" }),
					h.span([h.AriaHidden(true), h.Class("w-3.5 shrink-0")], []),
				]),
				toolTableBody(
					h,
					tools.length === 0
						? [
								emptyMessage(h, { className: "py-8 font-mono" }, [
									"No tool calls in this session",
								]),
							]
						: Arr.map(tools, (tool) => toolRow(h, tool, max, options)),
				),
			]),
		],
	)
}

const requestsPanel = <M>(
	h: HtmlBuilder<M>,
	data: McpSessionResponse,
	options: SessionBodyOptions<M>,
): Html => {
	const startMs = data.requests[0]?.timeMs ?? 0
	const max = Math.max(...Arr.map(data.requests, (row) => row.durationNs), 1)
	return h.section(
		[h.AriaLabel("Requests"), h.Class("@container/panel min-w-0 px-6 pt-6 pb-6")],
		[
			sectionTitle(h, "Requests", formatNumber(data.requests.length), headingNote(h, "in order")),
			toolTable(h, [
				toolTableHead(h, [
					th(h, { label: "Offset", width: "w-20 shrink-0" }),
					th(h, { label: "Request", width: "w-0 flex-1 min-w-0" }),
					th(h, {
						label: "Message",
						width: "w-0 flex-1 min-w-0",
						hidden: "hidden @min-[800px]/panel:flex",
					}),
					th(h, { label: "Duration", width: "w-52 shrink-0", align: "right" }),
					th(h, { label: "Result", width: RESULT_LANE }),
					th(h, {
						label: "Time",
						width: "w-14 shrink-0",
						align: "right",
						hidden: "hidden @min-[640px]/panel:flex",
					}),
					h.span([h.AriaHidden(true), h.Class("w-3.5 shrink-0")], []),
				]),
				toolTableBody(
					h,
					Arr.map(data.requests, (row) => requestRow(h, row, { startMs, max, options })),
				),
			]),
			toolTableFooter(
				h,
				data.isTruncated
					? `First ${formatNumber(data.requests.length)} requests`
					: `${formatNumber(data.requests.length)} ${pluralize(data.requests.length, "request")}`,
				data.isTruncated
					? "· narrow the time range to read the rest · each row opens its trace"
					: "· each row opens its trace",
			),
		],
	)
}

const sessionStats = <M>(h: HtmlBuilder<M>, data: McpSessionResponse): Html => {
	const calls = sessionCalls(data.requests)
	const failed = Arr.filter(calls, (row) => row.errorType !== null).length
	const callTime = Arr.reduce(calls, 0, (sum, row) => sum + row.durationNs)
	const requests = `${data.isTruncated ? "the first " : ""}${formatNumber(data.requests.length)} ${pluralize(data.requests.length, "request")}`
	return statRail(h, { columns: 4, isFlush: true }, [
		statRailItem(h, {
			eyebrow: "Tool calls",
			value: formatNumber(calls.length),
			subline: `of ${requests}`,
		}),
		statRailItem(h, {
			eyebrow: "Failed",
			value: formatNumber(failed),
			valueClassName: failed > 0 ? "text-severity-error" : undefined,
			subline:
				calls.length === 0 ? undefined : `${Math.round((failed / calls.length) * 100)}% of calls`,
		}),
		statRailItem(h, {
			eyebrow: "Length",
			value: formatLatency(sessionLengthMs(data.requests)),
			subline: "first request to last",
		}),
		statRailItem(h, {
			eyebrow: "Time in tools",
			value: formatDurationNs(callTime),
			subline: calls.length === 0 ? undefined : `${formatDurationNs(callTime / calls.length)} a call`,
		}),
	])
}

/** `McpSessionBody`: one session under its header. */
export const sessionBody = <M>(
	h: HtmlBuilder<M>,
	data: McpSessionResponse,
	options: SessionBodyOptions<M>,
): Html =>
	h.div(
		[h.Class("flex flex-col")],
		[
			sessionStats(h, data),
			agentSessionsPanel(h, data, options),
			toolsPanel(h, data, options),
			requestsPanel(h, data, options),
		],
	)
