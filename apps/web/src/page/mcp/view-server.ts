import { EMPTY_VALUE } from "@maple/ui/lib/empty-value"
import { formatErrorRate, pluralize } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { eyebrowVariants } from "@maple/ui/styles/ui/eyebrow"
import { errorRate, formatDurationNs, formatToolCount } from "@maple/web-data/lib/tool-analytics"
import { Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { emptyMessage } from "../../ui/empty"
import { icon } from "../../ui/icon"
import { meter } from "../../ui/meter"
import { selectableTile } from "../agent-sessions/tools-kit/metric-strip"
import type { ToolPercentile } from "../agent-sessions/tools-kit/model"
import {
	errorTone,
	shareCell,
	th,
	toolRowClass,
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
} from "./view-kit"

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
	isDurationServerWide: boolean
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
	h.span(
		[h.Class("inline-flex items-center gap-1.5 font-mono tabular-nums")],
		[h.span([], [lead]), h.span([h.Class("text-foreground-subtle")], [rest])],
	)

const metricStrip = <M>(h: HtmlBuilder<M>, data: McpServerOverview, options: ServerBodyOptions<M>): Html => {
	const { totals } = data
	const calls = data.series.map((point) => point.calls).slice(-SPARK_BUCKETS)
	const topClient = data.clients[0]
	// The share is of the listed clients' calls: a tool search can empty the totals.
	const clientCalls = data.clients.reduce((sum, client) => sum + client.calls, 0)
	const clientsPerBucket = data.series.map(
		(point) =>
			new Set(
				data.clientSeries
					.filter((c) => c.bucket === point.bucket && c.calls > 0)
					.map((c) => c.seriesKey),
			).size,
	)
	return h.div(
		[h.Class("flex flex-wrap border-b border-border @max-[900px]/page:flex-col")],
		[
			selectableTile(h, {
				eyebrow: "Tool calls",
				value: formatToolCount(totals.calls),
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
								`${data.tools.length} tools`,
								`· ${data.clients.length} ${pluralize(data.clients.length, "client")}`,
							),
				isSelected: options.metric === "calls",
				onSelect: options.onSelectMetric("calls"),
				className: TILE,
			}),
			selectableTile(h, {
				eyebrow: "Failed calls",
				value: formatErrorRate(errorRate(totals)),
				spark: data.series.map((point) => point.errors).slice(-SPARK_BUCKETS),
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
						spark: data.series.map((point) => point[options.percentile]).slice(-SPARK_BUCKETS),
						subline: options.isDurationServerWide
							? subline(h, "all clients", `· p50 ${formatDurationNs(totals.p50)}`)
							: subline(
									h,
									`p50 ${formatDurationNs(totals.p50)}`,
									`· p95 ${formatDurationNs(totals.p95)}`,
								),
						isSelected: options.metric === "duration",
						onSelect: options.onSelectMetric("duration"),
						ariaLabel: `${options.percentile.toUpperCase()} duration`,
						className: "h-full",
					}),
					options.percentileToggle,
				],
			),
			selectableTile(h, {
				eyebrow: "Clients",
				value: String(data.clients.length),
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
	return h.button(
		[h.Type("button"), h.Class(toolRowClass(false)), h.OnClick(options.onOpenTool(row.tool))],
		[
			h.span(
				[h.Class("flex w-0 min-w-0 flex-1 items-center gap-2")],
				[
					h.span(
						[
							h.AriaHidden(true),
							h.Class("size-2 shrink-0 rounded-xs"),
							h.Style({ "background-color": toolColor(index) }),
						],
						[],
					),
					h.span([h.Class("block min-w-0 truncate font-mono text-xs text-foreground")], [row.tool]),
				],
			),
			volumeSpark(h, options.env.spark, `mcp-tool-spark-${row.tool}`, row.spark),
			numberCell(h, formatToolCount(row.calls), "w-20 text-foreground"),
			duration(h, row.p50, options.percentile === "p50", "hidden @min-[900px]/panel:block"),
			duration(h, row.p90, options.percentile === "p90"),
			duration(h, row.p95, options.percentile === "p95", "hidden @min-[900px]/panel:block"),
			shareCell(h, { ratio: rate, max: maxRate, label: formatErrorRate(rate), tone: errorTone(rate) }),
			h.span(
				[h.Class("hidden w-28 shrink-0 pl-4 @min-[640px]/panel:block")],
				[
					row.topError === null
						? h.span([h.Class("font-mono text-xs text-foreground-subtle")], [EMPTY_VALUE])
						: errorTypeChip(h, row.topError),
				],
			),
			lastSeenCell(h, row.lastCallMs, options.nowMs, options.env.timeZone),
			h.span(
				[h.Class("flex w-3.5 shrink-0 items-center justify-end text-foreground-subtle")],
				[icon(h, "ChevronRightIcon", { size: 14 })],
			),
		],
	)
}

const toolsSection = <M>(h: HtmlBuilder<M>, data: McpServerOverview, options: ServerBodyOptions<M>): Html => {
	const maxRate = Math.max(...data.tools.map(errorRate), 0.0001)
	return h.section(
		[h.AriaLabel("Tools"), h.Class("@container/panel min-w-0 px-6 pt-5 pb-6")],
		[
			sectionTitle(h, "Tools", String(data.tools.length)),
			toolTable(h, [
				toolTableHead(h, [
					th(h, { label: "Tool", width: "w-0 flex-1 min-w-0" }),
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
					th(h, { label: "Failed", width: "w-36 shrink-0 pl-6" }),
					th(h, {
						label: "Top error",
						width: "w-28 shrink-0 pl-4",
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
						? [emptyMessage(h, { className: "py-8 font-mono" }, ["No tools match the filters."])]
						: data.tools.map((row, index) => toolRow(h, row, index, maxRate, options)),
				),
			]),
			toolTableFooter(
				h,
				data.tools.length === options.toolCount
					? `Showing all ${data.tools.length} tools`
					: `${data.tools.length} of ${options.toolCount} tools`,
				`· ${formatToolCount(data.totals.calls)} calls · ${formatErrorRate(errorRate(data.totals))} failed`,
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

const clientRow = <M>(h: HtmlBuilder<M>, row: McpClientRow, max: number): Html => {
	const rate = errorRate(row)
	return h.div(
		[h.Class("flex h-9 items-center gap-3 border-b border-border-subtle last:border-0")],
		[
			h.span(
				[h.Class("flex w-48 shrink-0 items-center gap-2 font-mono text-xs")],
				[clientIcon(h, row.name), h.span([h.Class("truncate")], [row.name]), ...kindTag(h, row.kind)],
			),
			meter(h, {
				value: row.calls,
				max,
				minVisible: 2,
				fillClassName: "bg-primary/70",
				className: "h-1.5 min-w-0 flex-1 rounded-xs bg-muted",
			}),
			numberCell(h, formatToolCount(row.calls), "w-14 text-foreground"),
			numberCell(
				h,
				row.errors === 0 ? EMPTY_VALUE : formatErrorRate(rate),
				cn("w-14", row.errors === 0 ? "text-foreground-subtle" : errorTone(rate).text),
			),
		],
	)
}

/** One `clientInfo.name` and how many initialize requests sent it. */
const initializerRow = <M>(
	h: HtmlBuilder<M>,
	row: Readonly<{ name: string; count: number }>,
	max: number,
): Html =>
	h.div(
		[h.Class("flex h-9 items-center gap-3 border-b border-border-subtle last:border-0")],
		[
			h.span(
				[h.Class("flex w-48 shrink-0 items-center gap-2 font-mono text-xs")],
				[clientIcon(h, row.name), h.span([h.Class("truncate")], [row.name])],
			),
			meter(h, {
				value: row.count,
				max,
				minVisible: 2,
				fillClassName: "bg-primary/70",
				className: "h-1.5 min-w-0 flex-1 rounded-xs bg-muted",
			}),
			numberCell(h, formatToolCount(row.count), "w-14 text-foreground"),
		],
	)

/** A failure kind's count, and its share of every tool call (caller mistakes are not failures). */
const failureRow = <M>(h: HtmlBuilder<M>, row: McpFailureKind, calls: number): Html =>
	h.div(
		[h.Class("flex items-center gap-3 border-b border-border-subtle py-2.5 last:border-0")],
		[
			h.div(
				[h.Class("min-w-0 flex-1")],
				[
					h.div(
						[h.Class("flex flex-wrap items-center gap-2 text-xs")],
						[row.label, ...row.codes.map((code) => attr(h, code))],
					),
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
	h.div(
		[h.Class("flex h-9 items-center gap-3 border-b border-border-subtle last:border-0")],
		[
			h.span([h.Class("w-0 min-w-0 flex-1 truncate font-mono text-xs")], [row.method]),
			numberCell(h, formatToolCount(row.calls), "w-16 text-foreground"),
			numberCell(h, row.p50 === 0 ? "<1ms" : formatDurationNs(row.p50), "w-20 text-muted-foreground"),
			numberCell(h, row.p95 === 0 ? "<1ms" : formatDurationNs(row.p95), "w-20 text-muted-foreground"),
		],
	)

const coverageRow = <M>(h: HtmlBuilder<M>, row: McpCoverageRow): Html =>
	h.div(
		[h.Class("flex items-start gap-2.5 border-b border-border-subtle py-2 last:border-0")],
		[
			icon(h, row.isPresent ? "CircleCheckIcon" : "CircleInfoIcon", {
				size: 14,
				className: cn(
					"mt-0.5 shrink-0",
					row.isPresent ? "text-severity-info" : "text-foreground-subtle",
				),
			}),
			h.div(
				[h.Class("min-w-0 flex-1")],
				[
					h.div(
						[h.Class("flex flex-wrap items-center gap-1.5 text-xs")],
						[row.label, ...row.attributes.map((name) => attr(h, name))],
					),
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
		],
	)

const methodsHead = <M>(h: HtmlBuilder<M>): Html => {
	const label = (text: string, width: string) =>
		h.span([h.Class(cn(width, eyebrowVariants({ variant: "mono" })))], [text])
	return h.div(
		[h.Class("flex h-8 items-center gap-3 border-y border-border")],
		[
			label("Method", "w-0 flex-1"),
			label("Calls", "w-16 text-right"),
			label("P50", "w-20 text-right"),
			label("P95", "w-20 text-right"),
		],
	)
}

const externalLink = <M>(h: HtmlBuilder<M>, label: string, href: string): Html =>
	h.a(
		[
			h.Href(href),
			h.Target("_blank"),
			h.Rel("noopener noreferrer"),
			h.Class(
				"inline-flex items-center gap-1 font-mono text-2xs text-muted-foreground hover:text-foreground active:text-foreground",
			),
		],
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

const clientsHalf = <M>(h: HtmlBuilder<M>, data: McpServerOverview, options: ServerBodyOptions<M>): Html => {
	if (options.clientIdentity === "info") {
		const max = Math.max(...data.initializers.map((entry) => entry.count), 1)
		return half(h, "Clients", options.clientToggle, [
			...data.initializers.map((entry) => initializerRow(h, entry, max)),
			note(h, [
				attr(h, "clientInfo"),
				" arrives on initialize only, so these count handshakes, not tool calls.",
			]),
		])
	}
	const max = Math.max(...data.clients.map((client) => client.calls), 1)
	const initializers = data.initializers
		.slice(0, 3)
		.map((entry) => `${entry.name} ${entry.count}`)
		.join(" · ")
	const rest = data.initializers.length - 3
	return half(h, "Clients", options.clientToggle, [
		...data.clients.map((client) => clientRow(h, client, max)),
		note(h, [
			"Calls carry ",
			attr(h, "user_agent.original"),
			". ",
			attr(h, "clientInfo"),
			` arrives on initialize only: ${initializers}${rest > 0 ? ` · ${rest} more` : ""}.`,
		]),
	])
}

const detailGrid = <M>(h: HtmlBuilder<M>, data: McpServerOverview, options: ServerBodyOptions<M>): Html => {
	const handshakes = data.methods.find((method) => method.method === "initialize")?.calls ?? 0
	const toolCalls = data.methods.find((method) => method.method === "tools/call")?.calls ?? 0
	const status = statusNote(data.totals.errors, data.totals.statusErrors)
	return h.div(
		[h.Class("grid @min-[900px]/page:grid-cols-2")],
		[
			clientsHalf(h, data, options),
			half(h, "Why calls fail", headingNote(h, `${data.totals.errors} failed`), [
				...data.failures.map((row) => failureRow(h, row, data.totals.calls)),
				...(status === undefined ? [] : [note(h, [status])]),
			]),
			half(
				h,
				"Protocol methods",
				toolCalls === 0
					? undefined
					: headingNote(h, `${(handshakes / toolCalls).toFixed(2)} initialize per tool call`),
				[methodsHead(h), ...data.methods.map((row) => methodRow(h, row))],
			),
			half(
				h,
				"Instrumentation",
				externalLink(h, "MCP conventions", SEMCONV_MCP_URL),
				data.coverage.map((row) => coverageRow(h, row)),
			),
		],
	)
}

/** `McpServerBody`: everything under the page header. */
export const serverBody = <M>(
	h: HtmlBuilder<M>,
	data: McpServerOverview,
	options: ServerBodyOptions<M>,
): Html =>
	h.div(
		[h.Class("flex flex-col")],
		[
			options.toolbar,
			mcpScopeRow(
				h,
				options.scope,
				formatToolCount(data.totals.calls),
				`tool calls · ${data.clients.length} ${pluralize(data.clients.length, "client")}`,
			),
			metricStrip(h, data, options),
			mainChart(h, data, options),
			toolsSection(h, data, options),
			h.div([h.Class("border-t border-border")], [detailGrid(h, data, options)]),
		],
	)
