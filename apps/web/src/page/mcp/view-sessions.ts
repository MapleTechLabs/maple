import type {
	McpSessionItem,
	McpSessionRequestItem,
	McpSessionResponse,
	McpSessionsResponse,
} from "@maple/domain/http"
import { formatLatency, formatNumber, pluralize } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { formatDurationNs } from "@maple/web-data/lib/tool-analytics"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "../../ui/icon"
import {
	shareCell,
	th,
	toolRowClass,
	toolTable,
	toolTableBody,
	toolTableFooter,
	toolTableHead,
} from "../agent-sessions/tools-kit/table"
import { filteredEmpty } from "../kit/signal-empty-state"
import { statRail, statRailItem } from "../kit/stat-rail"
import {
	attr,
	clientIcon,
	durationMeterCell,
	formatClock,
	headingNote,
	kindTag,
	lastSeenCell,
	mcpScopeRow,
	numberCell,
	resultCell,
	sectionTitle,
} from "./view-kit"

// `/mcp-servers/:service/sessions` and one session: a server's requests grouped by `mcp.session.id`,
// each session its requests in order, linked to the Agent Session whose trace made them.

export type SessionsBodyOptions<M> = Readonly<{
	toolbar: Html
	scope: string
	isWaiting: boolean
	isFailingOnly: boolean
	onOpenSession: (sessionId: string) => M
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

const sessionRow = <M>(h: HtmlBuilder<M>, row: McpSessionItem, options: SessionsBodyOptions<M>): Html =>
	h.button(
		[
			h.Type("button"),
			h.Key(row.sessionId),
			h.Class(toolRowClass(false)),
			h.OnClick(options.onOpenSession(row.sessionId)),
		],
		[
			h.span(
				[h.Class("w-0 min-w-0 flex-1 truncate font-mono text-xs text-foreground")],
				[row.sessionId],
			),
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
			numberCell(
				h,
				formatNumber(row.tools),
				"hidden w-14 text-muted-foreground @min-[800px]/panel:block",
			),
			numberCell(
				h,
				formatLatency(row.lastSeenMs - row.firstSeenMs),
				"hidden w-20 text-muted-foreground @min-[560px]/panel:block",
			),
			numberCell(h, formatClock(row.firstSeenMs, options.timeZone), "w-16 text-muted-foreground"),
			lastSeenCell(h, row.lastSeenMs, options.nowMs, options.timeZone),
			arrowCell(h),
		],
	)

/** The calls without a session id, when some carry one: those never reach this list. */
const partialCoverage = <M>(h: HtmlBuilder<M>, data: McpSessionsResponse): ReadonlyArray<Html> =>
	data.withSession >= data.toolCalls
		? []
		: [
				h.p(
					[h.Class("px-2.5 pt-3 font-prose text-xs text-muted-foreground")],
					[
						`${formatNumber(data.withSession)} of ${formatNumber(data.toolCalls)} tool calls carry `,
						attr(h, "mcp.session.id"),
						"; the rest belong to no session.",
					],
				),
			]

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
				`${pluralize(totals.sessions, "session")} · ${formatNumber(totals.failingSessions)} with a failed call`,
			),
			h.section(
				[h.AriaLabel("Sessions"), h.Class("@container/panel min-w-0 px-6 pt-6 pb-6")],
				[
					sectionTitle(h, "Sessions", formatNumber(data.sessions.length)),
					toolTable(h, [
						toolTableHead(h, [
							th(h, { label: "Session", width: "w-0 flex-1 min-w-0" }),
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
								: data.sessions.map((row) => sessionRow(h, row, options)),
							{ isWaiting: options.isWaiting },
						),
					]),
					toolTableFooter(
						h,
						`${formatNumber(data.sessions.length)} latest of ${formatNumber(matching)}`,
						"· each row opens the session",
					),
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
): ReadonlyArray<McpSessionRequestItem> => requests.filter((row) => row.method === "tools/call")

/** First request to last, as the sessions list measures it. */
export const sessionLengthMs = (requests: ReadonlyArray<McpSessionRequestItem>): number =>
	(requests.at(-1)?.timeMs ?? 0) - (requests[0]?.timeMs ?? 0)

/** The Agent Sessions behind the requests, the most requests first. */
export const linkedAgentSessions = (
	requests: ReadonlyArray<McpSessionRequestItem>,
): ReadonlyArray<Readonly<{ sessionId: string; requests: number }>> => {
	const counts = new Map<string, number>()
	requests.forEach((row) => {
		if (row.agentSessionId !== null)
			counts.set(row.agentSessionId, (counts.get(row.agentSessionId) ?? 0) + 1)
	})
	return [...counts]
		.map(([sessionId, count]) => ({ sessionId, requests: count }))
		.sort((a, b) => b.requests - a.requests)
}

/** Per tool across the session's calls: calls, failures and the time spent in it. `null` is a call naming no tool. */
export const sessionToolsOf = (
	requests: ReadonlyArray<McpSessionRequestItem>,
): ReadonlyArray<Readonly<{ tool: string | null; calls: number; errors: number; durationNs: number }>> => {
	const tools = new Map<string | null, { calls: number; errors: number; durationNs: number }>()
	sessionCalls(requests).forEach((row) => {
		const entry = tools.get(row.tool) ?? { calls: 0, errors: 0, durationNs: 0 }
		tools.set(row.tool, {
			calls: entry.calls + 1,
			errors: entry.errors + (row.errorType === null ? 0 : 1),
			durationNs: entry.durationNs + row.durationNs,
		})
	})
	return [...tools].map(([tool, entry]) => ({ tool, ...entry })).sort((a, b) => b.calls - a.calls)
}

/** `+1.2s` from the session's first request; the first reads `start`. */
const offsetLabel = (ms: number): string => (ms <= 0 ? "start" : `+${formatLatency(ms)}`)

const requestRow = <M>(
	h: HtmlBuilder<M>,
	row: McpSessionRequestItem,
	context: Readonly<{ startMs: number; max: number; options: SessionBodyOptions<M> }>,
): Html =>
	h.button(
		[
			h.Type("button"),
			h.Key(row.spanId),
			h.Class(toolRowClass(false)),
			h.OnClick(context.options.onOpenTrace(row.traceId)),
		],
		[
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
		],
	)

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
						linked.map((entry) =>
							h.button(
								[
									h.Type("button"),
									h.Key(entry.sessionId),
									h.Class(
										"inline-flex max-w-full items-center gap-2 rounded-md border border-border px-2.5 py-1.5 font-mono text-xs hover:bg-surface-sunken active:bg-surface-sunken",
									),
									h.OnClick(options.onOpenAgentSession(entry.sessionId)),
								],
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
		? h.div(
				[h.Key("no-tool-name"), h.Class(toolRowClass(false))],
				[...cells, h.span([h.Class("w-3.5 shrink-0")], [])],
			)
		: h.button(
				[
					h.Type("button"),
					h.Key(tool.tool),
					h.Class(toolRowClass(false)),
					h.OnClick(options.onOpenTool(tool.tool)),
				],
				[...cells, arrowCell(h)],
			)
}

const toolsPanel = <M>(h: HtmlBuilder<M>, data: McpSessionResponse, options: SessionBodyOptions<M>): Html => {
	const tools = sessionToolsOf(data.requests)
	const max = Math.max(...tools.map((tool) => tool.calls), 1)
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
						? [filteredEmpty(h, { noun: "tool calls", description: "", className: "py-8" })]
						: tools.map((tool) => toolRow(h, tool, max, options)),
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
	const max = Math.max(...data.requests.map((row) => row.durationNs), 1)
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
					th(h, { label: "Result", width: "w-28 shrink-0 pl-4" }),
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
					data.requests.map((row) => requestRow(h, row, { startMs, max, options })),
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
	const failed = calls.filter((row) => row.errorType !== null).length
	const callTime = calls.reduce((sum, row) => sum + row.durationNs, 0)
	const requests = `${data.isTruncated ? "the first " : ""}${formatNumber(data.requests.length)} ${pluralize(data.requests.length, "request")}`
	return statRail(h, { columns: 4, className: "border-b border-border" }, [
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
