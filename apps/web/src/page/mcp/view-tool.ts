import { formatErrorRate, formatNumber, pluralize } from "@maple/ui/lib/format"
import { TONE_FILL } from "@maple/ui/lib/tone"
import { formatDurationNs } from "@maple/web-data/lib/tool-analytics"
import { Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { emptyMessage } from "../../ui/empty"
import { icon } from "../../ui/icon"
import { meter } from "../../ui/meter"
import { miniBars } from "../../ui/mini-bars"
import {
	shareCell,
	th,
	toolRowClass,
	toolTable,
	toolTableBody,
	toolTableFooter,
	toolTableHead,
} from "../agent-sessions/tools-kit/table"
import type { ToolPercentile } from "../agent-sessions/tools-kit/model"
import type { McpCallRow, McpErrorGroup, McpToolDetail } from "./data"
import {
	attr,
	clientIcon,
	clientPlot,
	durationSeries,
	errorTypeChip,
	formatClock,
	headingNote,
	lastSeenCell,
	type McpChartEnv,
	type McpWindow,
	mcpPlot,
	mcpScopeRow,
	numberCell,
	sectionTitle,
	seriesRows,
} from "./view-kit"

// `/mcp/:service/tools/:tool`: the agent tool detail page for one MCP tool. Four charts, the
// failures grouped by `error.type` (and message, once the server records one), then the calls.

/** Which calls the Calls table lists. */
export const McpCallList = Schema.Literals(["slowest", "failed", "recent"])
export type McpCallList = typeof McpCallList.Type

export type ToolBodyOptions<M> = Readonly<{
	env: McpChartEnv<M>
	toolbar: Html
	/** What the toolbar narrows the page to, for the scope row. */
	scope: string
	window: McpWindow
	percentile: ToolPercentile
	callList: McpCallList
	callsToggle: Html
	onOpenGroup: (errorType: string) => M
	onOpenTrace: (traceId: string) => M
	nowMs: number
}>

const CELL = "@min-[900px]/page:[&:nth-child(odd)]:border-r"

const charts = <M>(h: HtmlBuilder<M>, data: McpToolDetail, options: ToolBodyOptions<M>): Html => {
	const { env } = options
	const rows = seriesRows(data.series)
	return h.div(
		[h.Class("grid @min-[900px]/page:grid-cols-2")],
		[
			mcpPlot(h, env, {
				chartId: "mcp-tool-calls",
				title: "Tool calls",
				rows,
				series: [
					{ key: "calls", label: "Calls", token: "--primary" },
					{ key: "failed", label: "Failed", token: "--color-severity-error" },
				],
				format: "number",
				height: 160,
				className: CELL,
			}),
			mcpPlot(h, env, {
				chartId: "mcp-tool-error-rate",
				title: "Failure rate",
				action: headingNote(h, `${data.errors} of ${formatNumber(data.calls)}`),
				rows,
				series: [{ key: "errorRate", label: "Failure rate", token: "--color-severity-error" }],
				format: "errorRate",
				height: 160,
				className: CELL,
			}),
			mcpPlot(h, env, {
				chartId: "mcp-tool-duration",
				title: "Duration",
				rows,
				series: durationSeries(options.percentile),
				format: "durationNs",
				height: 160,
				className: CELL,
			}),
			mcpPlot(h, env, {
				chartId: "mcp-tool-clients",
				title: "Calls by client",
				...clientPlot(data.clientSeries),
				format: "number",
				height: 160,
				className: CELL,
			}),
		],
	)
}

const errorRow = <M>(
	h: HtmlBuilder<M>,
	group: McpErrorGroup,
	total: number,
	options: ToolBodyOptions<M>,
): Html => {
	const share = group.count / Math.max(total, 1)
	return h.button(
		[h.Type("button"), h.Class(toolRowClass(false)), h.OnClick(options.onOpenGroup(group.errorType))],
		[
			h.span(
				[h.Class("flex w-0 min-w-0 flex-1 items-center gap-2 font-mono text-xs")],
				[
					errorTypeChip(h, group.errorType),
					group.message === null
						? h.span([h.Class("truncate text-foreground-subtle")], ["no message recorded"])
						: h.span([h.Class("truncate text-foreground")], [group.message]),
				],
			),
			h.span(
				[h.Class("hidden w-24 shrink-0 items-center @min-[720px]/panel:flex")],
				[
					miniBars(h, {
						values: group.trend,
						color: "var(--color-severity-error)",
						floor: 12.5,
						floorColor: "var(--input)",
						minHeight: 18.75,
						gap: group.trend.length > 12 ? 1 : 4.3,
						className: "h-4 w-24 shrink-0",
					}),
				],
			),
			shareCell(h, {
				ratio: share,
				max: 1,
				label: formatErrorRate(share),
				tone: { bar: TONE_FILL.crit, text: "text-muted-foreground" },
			}),
			numberCell(h, String(group.count), "w-20 text-foreground"),
			numberCell(
				h,
				String(group.clients),
				"hidden w-20 text-muted-foreground @min-[640px]/panel:block",
			),
			lastSeenCell(h, group.lastSeenMs, options.nowMs, options.env.timeZone),
			h.span(
				[h.Class("flex w-3.5 shrink-0 items-center justify-end text-foreground-subtle")],
				[icon(h, "ChevronRightIcon", { size: 14 })],
			),
		],
	)
}

const failures = <M>(h: HtmlBuilder<M>, data: McpToolDetail, options: ToolBodyOptions<M>): Html => {
	const isUnnamed = data.errorGroups.length > 0 && data.errorGroups.every((group) => group.message === null)
	return h.section(
		[h.AriaLabel("Failures"), h.Class("@container/panel min-w-0 px-6 pt-5 pb-2")],
		[
			sectionTitle(
				h,
				"Failures",
				`${data.errors} ${pluralize(data.errors, "failed call")} · ${data.errorGroups.length} ${pluralize(data.errorGroups.length, "kind")}`,
				h.span(
					[h.Class("font-mono text-2xs text-muted-foreground")],
					["grouped by ", attr(h, "error.type")],
				),
			),
			toolTable(h, [
				toolTableHead(h, [
					th(h, { label: "Error", width: "w-0 flex-1 min-w-0" }),
					th(h, {
						label: options.window.label,
						width: "w-24 shrink-0",
						hidden: "hidden @min-[720px]/panel:flex",
					}),
					th(h, { label: "Share", width: "w-36 shrink-0 pl-6" }),
					th(h, { label: "Count", width: "w-20 shrink-0", align: "right" }),
					th(h, {
						label: "Clients",
						width: "w-20 shrink-0",
						align: "right",
						hidden: "hidden @min-[640px]/panel:flex",
					}),
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
					data.errorGroups.length === 0
						? [
								emptyMessage(h, { className: "py-8 font-mono" }, [
									"No failed calls in this window.",
								]),
							]
						: data.errorGroups.map((group) => errorRow(h, group, data.errors, options)),
				),
			]),
			...(isUnnamed
				? [
						h.div(
							[
								h.Class(
									"mt-3 flex items-start gap-2.5 rounded-md border border-border bg-card px-3 py-2.5",
								),
							],
							[
								icon(h, "CircleInfoIcon", {
									size: 14,
									className: "mt-0.5 shrink-0 text-muted-foreground",
								}),
								h.p(
									[h.Class("font-prose text-xs leading-relaxed text-muted-foreground")],
									[
										"These failures carry no message, so they group as one. Record the tool's error text as an ",
										attr(h, "exception"),
										" event on the span (or opt into ",
										attr(h, "gen_ai.tool.call.result"),
										") and they split by cause, the way Agent Sessions groups them.",
									],
								),
							],
						),
					]
				: []),
		],
	)
}

const callRow = <M>(h: HtmlBuilder<M>, call: McpCallRow, max: number, options: ToolBodyOptions<M>): Html =>
	h.button(
		[h.Type("button"), h.Class(toolRowClass(false)), h.OnClick(options.onOpenTrace(call.traceId))],
		[
			h.span(
				[h.Class("w-20 shrink-0 font-mono text-xs tabular-nums text-muted-foreground")],
				[formatClock(call.timeMs, options.env.timeZone)],
			),
			h.span(
				[h.Class("flex w-0 min-w-0 flex-1 items-center gap-2 font-mono text-xs")],
				[clientIcon(h, call.client, 12), h.span([h.Class("truncate")], [call.client])],
			),
			numberCell(
				h,
				`#${call.requestId}`,
				"hidden w-16 text-foreground-subtle @min-[640px]/panel:block",
			),
			h.span(
				[h.Class("flex w-52 shrink-0 items-center justify-end gap-2.5")],
				[
					meter(h, {
						value: call.durationNs,
						max,
						minVisible: 3,
						fillClassName: call.errorType === null ? "bg-primary" : "bg-severity-error",
						className: "hidden w-28 shrink-0 rounded-xs bg-muted @min-[560px]/panel:block",
					}),
					h.span(
						[h.Class("w-14 text-right font-mono text-xs tabular-nums")],
						[formatDurationNs(call.durationNs)],
					),
				],
			),
			h.span(
				[h.Class("w-28 shrink-0 pl-4")],
				[
					call.errorType === null
						? h.span([h.Class("font-mono text-xs text-foreground-subtle")], ["ok"])
						: errorTypeChip(h, call.errorType),
				],
			),
			numberCell(
				h,
				call.traceId.slice(0, 8),
				"hidden w-20 text-muted-foreground @min-[800px]/panel:block",
			),
			h.span(
				[h.Class("flex w-3.5 shrink-0 items-center justify-end text-foreground-subtle")],
				[icon(h, "ArrowRightIcon", { size: 14 })],
			),
		],
	)

const LIST_NOUN = { slowest: "slowest", failed: "failed", recent: "most recent" } satisfies {
	readonly [K in McpCallList]: string
}

const calls = <M>(h: HtmlBuilder<M>, data: McpToolDetail, options: ToolBodyOptions<M>): Html => {
	const list = data[options.callList]
	const max = Math.max(...list.map((call) => call.durationNs), 1)
	return h.section(
		[h.AriaLabel("Calls"), h.Class("@container/panel min-w-0 px-6 pt-6 pb-6")],
		[
			sectionTitle(h, "Calls", undefined, options.callsToggle),
			toolTable(h, [
				toolTableHead(h, [
					th(h, { label: "Time", width: "w-20 shrink-0" }),
					th(h, { label: "Client", width: "w-0 flex-1 min-w-0" }),
					th(h, {
						label: "Request",
						width: "w-16 shrink-0",
						align: "right",
						hidden: "hidden @min-[640px]/panel:flex",
					}),
					th(h, { label: "Duration", width: "w-52 shrink-0", align: "right" }),
					th(h, { label: "Result", width: "w-28 shrink-0 pl-4" }),
					th(h, {
						label: "Trace",
						width: "w-20 shrink-0",
						align: "right",
						hidden: "hidden @min-[800px]/panel:flex",
					}),
					h.span([h.AriaHidden(true), h.Class("w-3.5 shrink-0")], []),
				]),
				toolTableBody(
					h,
					list.length === 0
						? [emptyMessage(h, { className: "py-8 font-mono" }, ["No calls match the filters."])]
						: list.map((call) => callRow(h, call, max, options)),
				),
			]),
			toolTableFooter(
				h,
				`${list.length} ${LIST_NOUN[options.callList]} of ${formatNumber(data.calls)}`,
				"· each row opens its trace",
			),
		],
	)
}

/** `McpToolBody`: everything under the tool page's header. */
export const toolBody = <M>(h: HtmlBuilder<M>, data: McpToolDetail, options: ToolBodyOptions<M>): Html =>
	h.div(
		[h.Class("flex flex-col")],
		[
			options.toolbar,
			mcpScopeRow(h, options.scope, formatNumber(data.calls), `calls · ${data.errors} failed`),
			charts(h, data, options),
			failures(h, data, options),
			calls(h, data, options),
		],
	)
