import { EMPTY_VALUE } from "@maple/ui/lib/empty-value"
import { formatErrorRate, formatNumber, pluralize } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { errorRate, formatDurationNs } from "@maple/web-data/lib/tool-analytics"
import { Schema, Array as Arr, String as Str, Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { emptyMessage } from "@maple/views/ui/empty"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { meter } from "@maple/views/ui/meter"
import { selectableTile } from "../agent-sessions/tools-kit/metric-strip"
import type { ToolPercentile } from "../agent-sessions/tools-kit/model"
import {
	errorTone,
	shareCell,
	th,
	toolTableRow,
	toolTable,
	toolTableBody,
	toolTableFooter,
	toolTableHead,
} from "../agent-sessions/tools-kit/table"
import type {
	McpClientRow,
	McpCoverageRow,
	McpFailureKind,
	McpMethodRow,
	McpServerOverview,
	McpToolRow,
} from "./data"
import {
	attr,
	clientIcon,
	clientPlot,
	durationSeries,
	errorTypeChip,
	formatClock,
	headingNote,
	kindTag,
	lastSeenCell,
	type McpChartEnv,
	type McpWindow,
	mcpPlot,
	mcpScopeRow,
	numberCell,
	SEMCONV_MCP_URL,
	sectionTitle,
	seriesRows,
	toolColor,
	volumeSpark,
	RESULT_LANE,
} from "./view-kit"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
import { columnClass } from "@maple/views/ui/column"
import { swatch } from "@maple/views/ui/swatch"
import { textLink } from "@maple/views/ui/text-link"

// `/mcp/:service`: the tools page's layout for one MCP server. Toolbar, scope, a metric strip that
// picks the chart, the tools table, then who calls, why calls fail, the protocol and what is sent.

export const McpMetric = Schema.Literals(["calls", "error_rate", "duration", "clients"])
export type McpMetric = typeof McpMetric.Type

/** Who a client is: its per-call `user_agent.original`, or the `clientInfo` it sent on initialize. */
export const McpClientIdentity = Schema.Literals(["ua", "info"])
export type McpClientIdentity = typeof McpClientIdentity.Type

export type ServerBodyOptions<M> = Readonly<{
	env: McpChartEnv<M>
	toolbar: Html
	/** What the toolbar narrows the page to, for the scope row. */
	scope: string
	window: McpWindow
	/** Every tool the server answered in the window, before the filters. */
	toolCount: number
	/** Durations have no per-client split: the tile says so while a client filter is set. */
	/** A filter narrows the page: durations stay server-wide, an empty table blames the filters. */
	isFiltered: boolean
	metric: McpMetric
	percentile: ToolPercentile
	onSelectMetric: (metric: McpMetric) => M
	percentileToggle: Html
	clientIdentity: McpClientIdentity
	clientToggle: Html
	onOpenTool: (tool: string) => M
	nowMs: number
}>

const TILE = "min-w-0 flex-1 border-l border-border first:border-l-0"
const SPARK_BUCKETS = 24

const subline = <M>(h: HtmlBuilder<M>, lead: string, rest: string): Html =>
	hstack(
		h,
		{ gap: "1.5", align: "center", inline: true, as: "span", className: "font-mono tabular-nums" },
		[h.span([], [lead]), typography(h, { tone: "subtle" }, [rest])],
	)

const metricStrip = <M>(h: HtmlBuilder<M>, data: McpServerOverview, options: ServerBodyOptions<M>): Html => {
	const { totals } = data
	const calls = Arr.map(data.series, (point) => point.calls).slice(-SPARK_BUCKETS)
	// Clients that only connected have no calls to rank or share.
	const callers = Arr.filter(data.clients, (client) => client.calls > 0)
	const topClient = callers[0]
	// The share is of the listed clients' calls: a tool search can empty the totals.
	const clientCalls = Arr.reduce(callers, 0, (sum, client) => sum + client.calls)
	const clientsPerBucket = Arr.map(
		data.series,
		(point) =>
			new Set(
				Arr.map(
					Arr.filter(data.clientSeries, (c) => c.bucket === point.bucket && c.calls > 0),
					(c) => c.seriesKey,
				),
			).size,
	)
	return h.div(
		[h.Class("flex flex-wrap border-b border-border @max-[900px]/page:flex-col")],
		[
			selectableTile(h, {
				eyebrow: "Tool calls",
				value: formatNumber(totals.calls),
				spark: calls,
				// Spans that start inside the window have no earlier stretch to compare against.
				subline:
					data.firstSpanMs >= options.window.startMs
						? subline(
								h,
								"first spans",
								`${formatClock(data.firstSpanMs, options.env.timeZone)} · nothing to compare`,
							)
						: subline(
								h,
								`${data.tools.length} ${pluralize(data.tools.length, "tool")}`,
								`· ${callers.length} ${pluralize(callers.length, "client")}`,
							),
				isSelected: options.metric === "calls",
				onSelect: options.onSelectMetric("calls"),
				className: TILE,
			}),
			selectableTile(h, {
				eyebrow: "Failed calls",
				value: formatErrorRate(errorRate(totals)),
				spark: Arr.map(data.series, (point) => point.errors).slice(-SPARK_BUCKETS),
				subline: subline(
					h,
					`${totals.errors} ${pluralize(totals.errors, "tool error")}`,
					`· ${totals.statusErrors} with Error status`,
				),
				isSelected: options.metric === "error_rate",
				onSelect: options.onSelectMetric("error_rate"),
				className: TILE,
			}),
			h.div(
				[h.Class(cn("relative", TILE))],
				[
					selectableTile(h, {
						eyebrow: "Duration",
						value: formatDurationNs(totals[options.percentile]),
						spark: Arr.map(data.series, (point) => point[options.percentile]).slice(
							-SPARK_BUCKETS,
						),
						subline: options.isFiltered
							? subline(h, "all calls", `· p50 ${formatDurationNs(totals.p50)}`)
							: subline(
									h,
									`p50 ${formatDurationNs(totals.p50)}`,
									`· p95 ${formatDurationNs(totals.p95)}`,
								),
						isSelected: options.metric === "duration",
						onSelect: options.onSelectMetric("duration"),
						ariaLabel: `${Str.toUpperCase(options.percentile)} duration`,
						className: "h-full",
					}),
					options.percentileToggle,
				],
			),
			selectableTile(h, {
				eyebrow: "Clients",
				value: String(callers.length),
				spark: clientsPerBucket.slice(-SPARK_BUCKETS),
				subline:
					topClient === undefined
						? null
						: subline(
								h,
								topClient.name,
								`${Math.round((topClient.calls / Math.max(clientCalls, 1)) * 100)}% of calls`,
							),
				isSelected: options.metric === "clients",
				onSelect: options.onSelectMetric("clients"),
				className: TILE,
			}),
		],
	)
}

const mainChart = <M>(h: HtmlBuilder<M>, data: McpServerOverview, options: ServerBodyOptions<M>): Html => {
	const { env } = options
	const bucketNote = headingNote(h, `${options.window.bucketLabel} buckets`)
	switch (options.metric) {
		case "calls":
			return mcpPlot(h, env, {
				chartId: "mcp-server-calls",
				title: "Tool calls",
				rows: seriesRows(data.series),
				series: [
					{ key: "calls", label: "Calls", token: "--primary" },
					{ key: "failed", label: "Failed", token: "--color-severity-error" },
				],
				format: "number",
				height: 220,
			})
		case "error_rate":
			return mcpPlot(h, env, {
				chartId: "mcp-server-error-rate",
				title: "Failed calls",
				action: bucketNote,
				rows: seriesRows(data.series),
				series: [{ key: "errorRate", label: "Failed", token: "--color-severity-error" }],
				format: "errorRate",
				height: 220,
			})
		case "duration":
			return mcpPlot(h, env, {
				chartId: "mcp-server-duration",
				title: "Duration",
				rows: seriesRows(data.series),
				series: durationSeries(options.percentile),
				format: "durationNs",
				height: 220,
			})
		case "clients":
			return mcpPlot(h, env, {
				chartId: "mcp-server-clients",
				title: "Tool calls by client",
				...clientPlot(data.clientSeries),
				format: "number",
				height: 220,
			})
	}
}

/** The Agent Tools duration cell: the picked percentile reads brighter. */
const duration = <M>(h: HtmlBuilder<M>, value: number, isDriving: boolean, hidden?: string): Html =>
	numberCell(
		h,
		formatDurationNs(value),
		cn("w-20", isDriving ? "text-foreground-soft" : "text-muted-foreground", hidden),
	)

const toolRow = <M>(
	h: HtmlBuilder<M>,
	row: McpToolRow,
	index: number,
	maxRate: number,
	options: ServerBodyOptions<M>,
): Html => {
	const rate = errorRate(row)
	return toolTableRow(h, { onClick: options.onOpenTool(row.tool) }, [
		hstack(h, { gap: "2", shrink: true, grow: true, as: "span", className: "w-0" }, [
			swatch(h, { ariaHidden: true, color: toolColor(index) }),
			typography(
				h,
				{ size: "xs", tone: "foreground", mono: true, truncate: true, className: "block min-w-0" },
				[row.tool],
			),
		]),
		volumeSpark(h, options.env.spark, `mcp-tool-spark-${row.tool}`, row.spark),
		numberCell(h, formatNumber(row.calls), "w-20 text-foreground"),
		duration(h, row.p50, options.percentile === "p50", "hidden @min-[900px]/panel:block"),
		duration(h, row.p90, options.percentile === "p90"),
		duration(h, row.p95, options.percentile === "p95", "hidden @min-[900px]/panel:block"),
		shareCell(h, { ratio: rate, max: maxRate, label: formatErrorRate(rate), tone: errorTone(rate) }),
		h.span(
			[h.Class(cn(RESULT_LANE, "hidden @min-[640px]/panel:block"))],
			[
				row.topError === null
					? typography(h, { size: "xs", tone: "subtle", mono: true }, [EMPTY_VALUE])
					: errorTypeChip(h, row.topError),
			],
		),
		lastSeenCell(h, row.lastCallMs, options.nowMs, options.env.timeZone),
		hstack(
			h,
			{
				justify: "end",
				as: "span",
				className: typographyClass({ tone: "subtle", className: "w-3.5 shrink-0" }),
			},
			[icon(h, "ChevronRightIcon", { size: 14 })],
		),
	])
}

const toolsSection = <M>(h: HtmlBuilder<M>, data: McpServerOverview, options: ServerBodyOptions<M>): Html => {
	const maxRate = Math.max(...Arr.map(data.tools, errorRate), 0.0001)
	return h.section(
		[h.AriaLabel("Tools"), h.Class("@container/panel min-w-0 px-6 pt-5 pb-6")],
		[
			sectionTitle(h, "Tools", String(data.tools.length)),
			toolTable(h, [
				toolTableHead(h, [
					th(h, { label: "Tool", width: columnClass({ min: "0" }) }),
					th(h, {
						label: "Volume",
						width: "w-28 shrink-0",
						hidden: "hidden @min-[720px]/panel:flex",
					}),
					th(h, { label: "Calls", width: "w-20 shrink-0", align: "right" }),
					th(h, {
						label: "P50",
						width: "w-20 shrink-0",
						align: "right",
						hidden: "hidden @min-[900px]/panel:flex",
					}),
					th(h, { label: "P90", width: "w-20 shrink-0", align: "right" }),
					th(h, {
						label: "P95",
						width: "w-20 shrink-0",
						align: "right",
						hidden: "hidden @min-[900px]/panel:flex",
					}),
					th(h, {
						label: "Failed",
						width: columnClass({ width: "36", shrink: false, inset: "6" }),
					}),
					th(h, {
						label: "Top error",
						width: RESULT_LANE,
						hidden: "hidden @min-[640px]/panel:flex",
					}),
					th(h, {
						label: "Last call",
						width: "w-24 shrink-0",
						align: "right",
						hidden: "hidden @min-[800px]/panel:flex",
					}),
					h.span([h.AriaHidden(true), h.Class("w-3.5 shrink-0")], []),
				]),
				toolTableBody(
					h,
					data.tools.length === 0
						? [
								emptyMessage(h, { className: "py-8 font-mono" }, [
									options.isFiltered
										? "No tools match these filters"
										: "No tool calls in this window",
								]),
							]
						: Arr.map(data.tools, (row, index) => toolRow(h, row, index, maxRate, options)),
				),
			]),
			toolTableFooter(
				h,
				data.tools.length === options.toolCount
					? `Showing all ${data.tools.length} ${pluralize(data.tools.length, "tool")}`
					: `${data.tools.length} of ${options.toolCount} tools`,
				`· ${formatNumber(data.totals.calls)} calls · ${formatErrorRate(errorRate(data.totals))} failed`,
			),
		],
	)
}

const half = <M>(
	h: HtmlBuilder<M>,
	title: string,
	right: Html | undefined,
	children: ReadonlyArray<Html>,
): Html =>
	h.section(
		[
			h.Class(
				"min-w-0 border-b border-border px-6 pt-5 pb-5 @min-[900px]/page:[&:nth-child(odd)]:border-r",
			),
		],
		[sectionTitle(h, title, undefined, right), ...children],
	)

const note = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html | string>): Html =>
	h.p([h.Class("mt-3 font-prose text-xs leading-relaxed text-muted-foreground")], children)

/** Callers the panel lists before "N more": the rest are a long tail of one-off agents. */
const CLIENT_ROWS = 8

/** `hasConnects` is false on a stateless server: with no `initialize`, nothing to count. */
const clientsHead = <M>(h: HtmlBuilder<M>, hasConnects: boolean): Html => {
	const label = (text: string, width: string, title?: string) =>
		eyebrow(
			h,
			{ variant: "mono", className: width, attributes: title === undefined ? [] : [h.Title(title)] },
			[text],
		)
	return hstack(h, { gap: "3", align: "center", className: "h-8 border-y border-border" }, [
		label("Client", "w-0 flex-1"),
		label("Calls", "w-14 text-right"),
		...(hasConnects ? [label("Connects", "w-16 text-right", "initialize requests")] : []),
		label("Sources", "w-14 text-right", "distinct client.address values"),
		label("Failed", "w-14 text-right"),
	])
}

const clientRow = <M>(h: HtmlBuilder<M>, row: McpClientRow, max: number, hasConnects: boolean): Html => {
	const rate = errorRate(row)
	const isQuiet = row.calls === 0
	return hstack(
		h,
		{ gap: "3", align: "center", className: "h-9 border-b border-border-subtle last:border-0" },
		[
			vstack(h, { gap: "1", justify: "center", shrink: true, grow: true, className: "w-0" }, [
				hstack(
					h,
					{
						gap: "2",
						align: "center",
						shrink: true,
						as: "span",
						className: typographyClass({ mono: true, size: "xs" }),
					},
					[
						clientIcon(h, row.name),
						h.span([h.Class(cn("truncate", isQuiet && "text-muted-foreground"))], [row.name]),
						...kindTag(h, row.kind),
					],
				),
				...(isQuiet
					? []
					: [
							meter(h, {
								value: row.calls,
								max,
								minVisible: 2,
								fillClassName: "bg-primary/70",
								className: "h-1 w-full rounded-xs bg-muted",
							}),
						]),
			]),
			numberCell(
				h,
				isQuiet ? EMPTY_VALUE : formatNumber(row.calls),
				cn("w-14", isQuiet ? "text-foreground-subtle" : "text-foreground"),
			),
			...(hasConnects
				? [
						numberCell(
							h,
							row.connects === 0 ? EMPTY_VALUE : formatNumber(row.connects),
							"w-16 text-muted-foreground",
						),
					]
				: []),
			numberCell(
				h,
				row.sources === 0 ? EMPTY_VALUE : formatNumber(row.sources),
				"w-14 text-muted-foreground",
			),
			numberCell(
				h,
				row.errors === 0 ? EMPTY_VALUE : formatErrorRate(rate),
				cn("w-14", row.errors === 0 ? "text-foreground-subtle" : errorTone(rate).text),
			),
		],
	)
}

/** A label row between the callers and the clients that only connected. */
const clientGroupLabel = <M>(h: HtmlBuilder<M>, text: string): Html =>
	hstack(h, { align: "end", className: "h-8 border-b border-border-subtle pb-1.5" }, [
		eyebrow(h, { variant: "mono" }, [text]),
	])

/** One `clientInfo.name` and how many requests sent it. */
const clientInfoRow = <M>(
	h: HtmlBuilder<M>,
	row: Readonly<{ name: string; count: number }>,
	max: number,
): Html =>
	hstack(h, { gap: "3", align: "center", className: "h-9 border-b border-border-subtle last:border-0" }, [
		hstack(h, { gap: "2", align: "center", as: "span", className: "w-48 shrink-0 font-mono text-xs" }, [
			clientIcon(h, row.name),
			typography(h, { truncate: true }, [row.name]),
		]),
		meter(h, {
			value: row.count,
			max,
			minVisible: 2,
			fillClassName: "bg-primary/70",
			className: "h-1.5 min-w-0 flex-1 rounded-xs bg-muted",
		}),
		numberCell(h, formatNumber(row.count), "w-14 text-foreground"),
	])

/** A failure kind's count, and its share of every tool call (caller mistakes are not failures). */
const failureRow = <M>(h: HtmlBuilder<M>, row: McpFailureKind, calls: number): Html =>
	hstack(
		h,
		{ gap: "3", align: "center", className: "border-b border-border-subtle py-2.5 last:border-0" },
		[
			h.div(
				[h.Class("min-w-0 flex-1")],
				[
					hstack(h, { gap: "2", wrap: true, className: typographyClass({ size: "xs" }) }, [
						row.label,
						...Arr.map(row.codes, (code) => attr(h, code)),
					]),
					h.div([h.Class("mt-0.5 font-prose text-xs text-muted-foreground")], [row.detail]),
				],
			),
			numberCell(
				h,
				String(row.count),
				cn("w-12", row.count > 0 ? "text-severity-error" : "text-foreground-subtle"),
			),
			numberCell(
				h,
				row.count === 0 ? EMPTY_VALUE : formatErrorRate(row.count / Math.max(calls, 1)),
				"w-14 text-muted-foreground",
			),
		],
	)

const methodRow = <M>(h: HtmlBuilder<M>, row: McpMethodRow): Html =>
	hstack(h, { gap: "3", align: "center", className: "h-9 border-b border-border-subtle last:border-0" }, [
		h.span([h.Class("w-0 min-w-0 flex-1 truncate font-mono text-xs")], [row.method]),
		numberCell(h, formatNumber(row.calls), "w-16 text-foreground"),
		numberCell(h, row.p50 === 0 ? "<1ms" : formatDurationNs(row.p50), "w-20 text-muted-foreground"),
		numberCell(h, row.p95 === 0 ? "<1ms" : formatDurationNs(row.p95), "w-20 text-muted-foreground"),
	])

const coverageRow = <M>(h: HtmlBuilder<M>, row: McpCoverageRow): Html =>
	hstack(h, { gap: "2.5", align: "start", className: "border-b border-border-subtle py-2 last:border-0" }, [
		icon(h, row.isPresent ? "CircleCheckIcon" : "CircleInfoIcon", {
			size: 14,
			className: cn("mt-0.5 shrink-0", row.isPresent ? "text-severity-info" : "text-foreground-subtle"),
		}),
		h.div(
			[h.Class("min-w-0 flex-1")],
			[
				hstack(h, { gap: "1.5", align: "center", wrap: true, className: "text-xs" }, [
					row.label,
					...Arr.map(row.attributes, (name) => attr(h, name)),
				]),
				h.div(
					[
						h.Class(
							cn(
								"mt-0.5 font-prose text-xs",
								row.isPresent ? "text-muted-foreground" : "text-foreground-soft",
							),
						),
					],
					[row.detail],
				),
			],
		),
	])

const methodsHead = <M>(h: HtmlBuilder<M>): Html => {
	const label = (text: string, width: string) => eyebrow(h, { variant: "mono", className: width }, [text])
	return hstack(h, { gap: "3", align: "center", className: "h-8 border-y border-border" }, [
		label("Method", "w-0 flex-1"),
		label("Calls", "w-16 text-right"),
		label("P50", "w-20 text-right"),
		label("P95", "w-20 text-right"),
	])
}

const externalLink = <M>(h: HtmlBuilder<M>, label: string, href: string): Html =>
	textLink(
		h,
		{
			href,
			tone: "muted",
			isMono: true,
			className: "text-2xs",
			attributes: [h.Target("_blank"), h.Rel("noopener noreferrer")],
		},
		[label, icon(h, "ExternalLinkIcon", { size: 10 })],
	)

/** Every tool error read off the span status: all Ok, some Ok, or none. */
const statusNote = (errors: number, statusErrors: number): string | undefined => {
	const ok = Math.max(errors - statusErrors, 0)
	if (errors === 0 || ok === 0) return undefined
	const reading = ok === errors ? "reads 0% failed" : "undercounts them"
	const lead =
		ok === errors
			? errors === 1
				? "The 1 failure has"
				: `All ${errors} have`
			: `${ok} of ${errors} have`
	return `${lead} span status Ok: the spec keeps tool errors off the status, so a status-only view ${reading}.`
}

/** The window's `initialize` requests: none on a stateless server (MCP 2026-07-28). */
const handshakesOf = (data: McpServerOverview): number => callsOf(data, "initialize")

/** The window's calls of one JSON-RPC method, 0 when it was not called. */
const callsOf = (data: McpServerOverview, name: string): number =>
	Option.match(
		Arr.findFirst(data.methods, (method) => method.method === name),
		{ onNone: () => 0, onSome: (method) => method.calls },
	)

const clientsHalf = <M>(h: HtmlBuilder<M>, data: McpServerOverview, options: ServerBodyOptions<M>): Html => {
	const handshakes = handshakesOf(data)
	const hasConnects = handshakes > 0
	const isPerConnect = data.clientInfoUnit === "connect"
	// Without any `clientInfo` there is nothing to switch to.
	const toggle = data.clientInfo.length === 0 ? undefined : options.clientToggle
	if (options.clientIdentity === "info" && toggle !== undefined) {
		const max = Math.max(...Arr.map(data.clientInfo, (entry) => entry.count), 1)
		return half(h, "Clients", toggle, [
			...Arr.map(data.clientInfo, (entry) => clientInfoRow(h, entry, max)),
			note(
				h,
				isPerConnect
					? [
							attr(h, "clientInfo"),
							" arrives on initialize, so these count handshakes; a stateless request sends it with each call.",
						]
					: [attr(h, "clientInfo"), " came with these requests, handshakes included."],
			),
		])
	}
	const callers = Arr.filter(data.clients, (client) => client.calls > 0)
	const quiet = Arr.filter(data.clients, (client) => client.calls === 0)
	const max = Math.max(...Arr.map(callers, (client) => client.calls), 1)
	const shown = callers.slice(0, CLIENT_ROWS)
	const hidden = callers.slice(CLIENT_ROWS)
	const named = Arr.join(
		Arr.map(data.clientInfo.slice(0, 3), (entry) => `${entry.name} ${entry.count}`),
		" · ",
	)
	const rest = data.clientInfo.length - 3
	return half(h, "Clients", toggle, [
		clientsHead(h, hasConnects),
		...Arr.map(shown, (client) => clientRow(h, client, max, hasConnects)),
		...(hidden.length === 0
			? []
			: [
					note(h, [
						`${hidden.length} more ${pluralize(hidden.length, "client")} · ${formatNumber(
							Arr.reduce(hidden, 0, (sum, client) => sum + client.calls),
						)} calls`,
					]),
				]),
		...(quiet.length === 0
			? []
			: [
					clientGroupLabel(h, `Connected, no tool calls · ${quiet.length}`),
					...Arr.map(quiet, (client) => clientRow(h, client, max, hasConnects)),
				]),
		note(h, [
			"Calls carry ",
			attr(h, "user_agent.original"),
			...(hasConnects
				? ["; a connect is one ", attr(h, "initialize"), ", and agents reconnect often."]
				: ["."]),
			...(named === ""
				? []
				: [
						" ",
						attr(h, "clientInfo"),
						` ${isPerConnect ? "per connect" : "per request"}: ${named}${rest > 0 ? ` · ${rest} more` : ""}.`,
					]),
		]),
	])
}

const detailGrid = <M>(h: HtmlBuilder<M>, data: McpServerOverview, options: ServerBodyOptions<M>): Html => {
	const handshakes = handshakesOf(data)
	const toolCalls = callsOf(data, "tools/call")
	const status = statusNote(data.totals.errors, data.totals.statusErrors)
	return h.div(
		[h.Class("grid @min-[900px]/page:grid-cols-2")],
		[
			clientsHalf(h, data, options),
			half(h, "Why calls fail", headingNote(h, `${data.totals.errors} failed`), [
				...Arr.map(data.failures, (row) => failureRow(h, row, data.totals.calls)),
				...(status === undefined ? [] : [note(h, [status])]),
			]),
			half(
				h,
				"Protocol methods",
				toolCalls === 0 || handshakes === 0
					? undefined
					: headingNote(h, `${(handshakes / toolCalls).toFixed(2)} initialize per tool call`),
				[methodsHead(h), ...Arr.map(data.methods, (row) => methodRow(h, row))],
			),
			half(
				h,
				"Instrumentation",
				externalLink(h, "MCP conventions", SEMCONV_MCP_URL),
				Arr.map(data.coverage, (row) => coverageRow(h, row)),
			),
		],
	)
}

/** `McpServerBody`: everything under the page header. */
export const serverBody = <M>(
	h: HtmlBuilder<M>,
	data: McpServerOverview,
	options: ServerBodyOptions<M>,
): Html => {
	const callerCount = Arr.filter(data.clients, (client) => client.calls > 0).length
	return vstack(h, {}, [
		options.toolbar,
		mcpScopeRow(
			h,
			options.scope,
			formatNumber(data.totals.calls),
			`tool calls · ${callerCount} ${pluralize(callerCount, "client")}`,
		),
		metricStrip(h, data, options),
		mainChart(h, data, options),
		toolsSection(h, data, options),
		h.div([h.Class("border-t border-border")], [detailGrid(h, data, options)]),
	])
}
