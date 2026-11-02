import { formatErrorRate, formatNumber } from "@maple/ui/lib/format"
import { errorRate, formatDurationNs } from "@maple/web-data/lib/tool-analytics"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import { icon } from "../../ui/icon"
import { serviceDot } from "../../ui/values"
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
import type { McpServerRow } from "./data"
import {
	attr,
	clientIcon,
	lastSeenCell,
	type McpSparkEnv,
	numberCell,
	SEMCONV_MCP_URL,
	sectionTitle,
	volumeSpark,
} from "./view-kit"

// `/mcp`: every service that answers MCP requests, one row each.

export type ListBodyOptions<M> = Readonly<{
	onOpenServer: (service: string) => M
	onInstrument: M
	nowMs: number
	timeZone: string
	spark: McpSparkEnv<M>
}>

const serverRow = <M>(
	h: HtmlBuilder<M>,
	row: McpServerRow,
	maxRate: number,
	options: ListBodyOptions<M>,
): Html => {
	const rate = errorRate(row)
	return toolTableRow(
		h,
		{ onClick: options.onOpenServer(row.service) },
		[
			h.span(
				[h.Class("flex w-0 min-w-0 flex-1 items-center gap-2")],
				[
					serviceDot(h, { serviceName: row.service }),
					h.span(
						[h.Class("block min-w-0 truncate font-mono text-xs text-foreground")],
						[row.service],
					),
				],
			),
			h.span(
				[
					h.Class(
						"hidden w-24 shrink-0 font-mono text-2xs text-muted-foreground @min-[900px]/panel:block",
					),
				],
				[row.protocolVersion],
			),
			volumeSpark(h, options.spark, `mcp-server-spark-${row.service}`, row.spark),
			numberCell(h, formatNumber(row.calls), "w-20 text-foreground"),
			shareCell(h, { ratio: rate, max: maxRate, label: formatErrorRate(rate), tone: errorTone(rate) }),
			numberCell(h, formatDurationNs(row.p95), "w-20 text-foreground-soft"),
			numberCell(h, String(row.tools), "hidden w-14 text-muted-foreground @min-[640px]/panel:block"),
			h.span(
				[
					h.Class(
						"hidden w-40 shrink-0 items-center gap-1.5 pl-4 font-mono text-xs @min-[800px]/panel:flex",
					),
				],
				[
					clientIcon(h, row.topClient, 12),
					row.topClient,
					h.span([h.Class("text-foreground-subtle")], [`${Math.round(row.topClientShare * 100)}%`]),
				],
			),
			lastSeenCell(h, row.lastCallMs, options.nowMs, options.timeZone),
			h.span(
				[h.Class("flex w-3.5 shrink-0 items-center justify-end text-foreground-subtle")],
				[icon(h, "ChevronRightIcon", { size: 14 })],
			),
		],
	)
}

/** The quiet strip under the table: any server that follows the conventions joins the list. */
const addServerStrip = <M>(h: HtmlBuilder<M>, onInstrument: M): Html =>
	h.div(
		[
			h.Class(
				"mt-6 flex flex-wrap items-center justify-between gap-4 rounded-md border border-dashed border-border px-4 py-3",
			),
		],
		[
			h.span(
				[h.Class("flex items-center gap-3 font-prose text-sm text-muted-foreground")],
				[
					icon(h, "PlugIcon", { size: 16, className: "shrink-0" }),
					h.span(
						[],
						[
							"Any MCP server that sends spans with ",
							attr(h, "mcp.method.name"),
							" shows up here, ours or yours.",
						],
					),
				],
			),
			h.span(
				[h.Class("flex shrink-0 items-center gap-4")],
				[
					h.a(
						[
							h.Href(SEMCONV_MCP_URL),
							h.Target("_blank"),
							h.Rel("noopener noreferrer"),
							h.Class(
								"inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground active:text-foreground",
							),
						],
						["MCP conventions", icon(h, "ExternalLinkIcon", { size: 12 })],
					),
					button(h, { variant: "outline", size: "sm", attributes: [h.OnClick(onInstrument)] }, [
						icon(h, "PlugIcon", { size: 14 }),
						"Instrument a server",
					]),
				],
			),
		],
	)

/** `McpServersBody`: the servers table. */
export const listBody = <M>(
	h: HtmlBuilder<M>,
	rows: ReadonlyArray<McpServerRow>,
	options: ListBodyOptions<M>,
): Html => {
	const maxRate = Math.max(...rows.map(errorRate), 0.0001)
	const calls = rows.reduce((sum, row) => sum + row.calls, 0)
	const errors = rows.reduce((sum, row) => sum + row.errors, 0)
	return h.section(
		[h.AriaLabel("Servers"), h.Class("@container/panel min-w-0 border-t border-border px-6 pt-5 pb-6")],
		[
			sectionTitle(h, "Servers", String(rows.length)),
			toolTable(h, [
				toolTableHead(h, [
					th(h, { label: "Server", width: "w-0 flex-1 min-w-0" }),
					th(h, {
						label: "Protocol",
						width: "w-24 shrink-0",
						hidden: "hidden @min-[900px]/panel:flex",
					}),
					th(h, {
						label: "Volume",
						width: "w-28 shrink-0",
						hidden: "hidden @min-[720px]/panel:flex",
					}),
					th(h, { label: "Tool calls", width: "w-20 shrink-0", align: "right" }),
					th(h, { label: "Failed", width: "w-36 shrink-0 pl-6" }),
					th(h, { label: "P95", width: "w-20 shrink-0", align: "right" }),
					th(h, {
						label: "Tools",
						width: "w-14 shrink-0",
						align: "right",
						hidden: "hidden @min-[640px]/panel:flex",
					}),
					th(h, {
						label: "Top client",
						width: "w-40 shrink-0 pl-4",
						hidden: "hidden @min-[800px]/panel:flex",
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
					rows.map((row) => serverRow(h, row, maxRate, options)),
				),
			]),
			toolTableFooter(
				h,
				`${rows.length} MCP ${rows.length === 1 ? "server" : "servers"}`,
				`· ${formatNumber(calls)} tool calls · ${formatNumber(errors)} failed`,
			),
			addServerStrip(h, options.onInstrument),
		],
	)
}
