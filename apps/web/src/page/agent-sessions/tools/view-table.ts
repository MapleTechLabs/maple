import { formatNumber } from "@maple/ui/lib/format"
import { formatErrorRate } from "@maple/ui/lib/error-rate"
import { cn } from "@maple/ui/lib/utils"
import {
	breakdownKeyLabel,
	errorRate,
	formatDurationNs,
	toolsTableFooter,
} from "@maple/web-data/lib/tool-analytics"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { LoadFailure } from "../../../data/load-failure"
import { AppRoute, hrefOf } from "../../../route"
import { emptyMessage } from "../../../ui/empty"
import { errorState } from "../../../ui/error-state"
import { icon } from "../../../ui/icon"
import { skeletonList } from "../../../ui/skeleton"
import type { ToolBreakdownRow, ToolPercentile, ToolSearch } from "../tools-kit/model"
import { volumeSparkCell } from "../tools-kit/spark"
import { toolDetailLinkSearch } from "../tools-kit/model"
import {
	errorTone,
	shareCell,
	type SortState,
	sortRows,
	th,
	toolTableRow,
	toolTable,
	toolTableBody,
	toolTableFooter,
	toolTableHead,
} from "../tools-kit/table"
import { relativeTime } from "../../kit/relative-time"
import { Message } from "./message"

type H = HtmlBuilder<Message>

export type ToolsTableInputs = Readonly<{
	rows: ReadonlyArray<ToolBreakdownRow>
	percentile: ToolPercentile
	search: ToolSearch
	sort: SortState
	sparkFor: (tool: string) => ReadonlyArray<number>
	colorFor: (tool: string) => string | undefined
	/** The spark colour, resolved for the canvas. */
	sparkColor: string
	isLoading: boolean
	failure: LoadFailure | undefined
	isWaiting: boolean
	nowMs: number
	timeZone: string
}>

const head = (h: H, sort: SortState): Html => {
	const sortable = (label: string, width: string, key: string, align?: "right", hidden?: string) =>
		th(h, {
			label,
			width,
			sortKey: key,
			sort,
			onSort: (sortKey) => Message.ClickedTableSort({ key: sortKey }),
			align,
			hidden,
		})
	return toolTableHead(h, [
		sortable("Tool", "w-0 flex-1 min-w-0", "key"),
		th(h, { label: "Volume", width: "w-28 shrink-0", hidden: "hidden @min-[720px]/panel:flex" }),
		sortable("Calls", "w-20 shrink-0", "calls", "right"),
		sortable("P50", "w-20 shrink-0", "p50", "right", "hidden @min-[900px]/panel:flex"),
		sortable("P90", "w-20 shrink-0", "p90", "right"),
		sortable("P95", "w-20 shrink-0", "p95", "right", "hidden @min-[900px]/panel:flex"),
		sortable("Error rate", "w-36 shrink-0 pl-6", "errorRate"),
		sortable("Errors", "w-20 shrink-0", "errors", "right", "hidden @min-[640px]/panel:flex"),
		sortable("Sessions", "w-20 shrink-0", "sessions", "right", "hidden @min-[640px]/panel:flex"),
		sortable("Last call", "w-24 shrink-0", "lastSeen", "right", "hidden @min-[800px]/panel:flex"),
		h.span([h.AriaHidden(true), h.Class("w-3.5 shrink-0")], []),
	])
}

type Prepared = ToolBreakdownRow & { readonly errorRate: number }

const SORT_FIELDS = new Map<string, (row: Prepared) => string | number>([
	["key", (row) => row.key],
	["calls", (row) => row.calls],
	["p50", (row) => row.p50],
	["p90", (row) => row.p90],
	["p95", (row) => row.p95],
	["errorRate", (row) => row.errorRate],
	["errors", (row) => row.errors],
	["sessions", (row) => row.sessions],
	["lastSeen", (row) => row.lastSeen],
])

const duration = (h: H, value: number, isDriving: boolean, hidden?: string): Html =>
	h.span(
		[
			h.Class(
				cn(
					"w-20 shrink-0 text-right font-mono text-xs tabular-nums",
					isDriving ? "text-foreground-soft" : "text-muted-foreground",
					hidden,
				),
			),
		],
		[formatDurationNs(value)],
	)

const cells = (h: H, row: Prepared, inputs: ToolsTableInputs, maxErrorRate: number): ReadonlyArray<Html> => {
	const color = inputs.colorFor(row.key)
	return [
		h.span(
			[h.Class("flex w-0 min-w-0 flex-1 items-center gap-2")],
			[
				h.span(
					[
						h.AriaHidden(true),
						h.Class(
							cn("size-2 shrink-0 rounded-xs", color === undefined && "bg-foreground-subtle"),
						),
						...(color === undefined ? [] : [h.Style({ "background-color": color })]),
					],
					[],
				),
				h.span(
					[
						h.Class(
							cn(
								"block min-w-0 truncate font-mono",
								"text-xs text-foreground",
								row.key === inputs.search.tool && "font-medium",
							),
						),
						h.Title(breakdownKeyLabel(row.key)),
					],
					[breakdownKeyLabel(row.key)],
				),
			],
		),
		volumeSparkCell(h, {
			chartId: `tool-spark-${row.key}`,
			values: inputs.sparkFor(row.key),
			color: inputs.sparkColor,
			toMessage: (message) => Message.GotSparkMessage({ message }),
		}),
		h.span(
			[h.Class("w-20 shrink-0 text-right font-mono text-xs tabular-nums text-foreground")],
			[formatNumber(row.calls)],
		),
		duration(h, row.p50, inputs.percentile === "p50", "hidden @min-[900px]/panel:block"),
		duration(h, row.p90, inputs.percentile === "p90"),
		duration(h, row.p95, inputs.percentile === "p95", "hidden @min-[900px]/panel:block"),
		shareCell(h, {
			ratio: row.errorRate,
			max: maxErrorRate,
			label: formatErrorRate(row.errorRate),
			tone: errorTone(row.errorRate),
		}),
		h.span(
			[
				h.Class(
					cn(
						"hidden w-20 shrink-0 text-right font-mono text-xs tabular-nums @min-[640px]/panel:block",
						// The count takes the rate's tone, so one threshold colours both.
						row.errors > 0 ? errorTone(row.errorRate).text : "text-foreground-subtle",
					),
				),
			],
			[formatNumber(row.errors)],
		),
		h.span(
			[
				h.Class(
					"hidden w-20 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground @min-[640px]/panel:block",
				),
			],
			[formatNumber(row.sessions)],
		),
		relativeTime(h, {
			value: row.lastSeen,
			variant: "orDate",
			tooltip: "title",
			nowMs: inputs.nowMs,
			timeZone: inputs.timeZone,
			className:
				"hidden w-24 shrink-0 text-right font-mono text-2xs tabular-nums text-foreground-subtle @min-[800px]/panel:block",
		}),
		h.span(
			[h.Class("flex w-3.5 shrink-0 items-center justify-end text-foreground-subtle")],
			row.key === ""
				? []
				: [icon(h, "ChevronRightIcon", { size: 14, attributes: [h.AriaHidden(true)] })],
		),
	]
}

const body = (h: H, inputs: ToolsTableInputs): ReadonlyArray<Html> => {
	if (inputs.failure !== undefined)
		return [errorState(h, { failure: inputs.failure, title: "Couldn't load tools" })]
	if (inputs.isLoading)
		return [skeletonList(h, { rows: 3, rowClassName: "h-[38px]", className: "gap-1.5 px-2.5 py-3" })]
	if (inputs.rows.length === 0)
		return [emptyMessage(h, { className: "py-12 font-mono" }, ["No tool calls in this window"])]
	const prepared: ReadonlyArray<Prepared> = inputs.rows.map((row) => ({
		...row,
		errorRate: errorRate(row),
	}))
	const maxErrorRate = prepared.reduce((max, row) => Math.max(max, row.errorRate), 0)
	const linkSearch = toolDetailLinkSearch(inputs.search)
	return sortRows(prepared, inputs.sort, (row, key) => SORT_FIELDS.get(key)?.(row)).map((row) =>
		row.key === ""
			? toolTableRow(h, { attributes: [h.Key(row.key)] }, cells(h, row, inputs, maxErrorRate))
			: toolTableRow(
					h,
					{
						isSelected: row.key === inputs.search.tool,
						href: hrefOf(AppRoute.AgentSessionTool({ toolName: row.key, search: linkSearch })),
						attributes: [h.Key(row.key)],
					},
					cells(h, row, inputs, maxErrorRate),
				),
	)
}

/** Totals of rows that have not arrived are not totals: drawn once the read answered. */
const footerOf = (h: H, rows: ReadonlyArray<ToolBreakdownRow>): Html => {
	const footer = toolsTableFooter(rows)
	return toolTableFooter(h, footer.subject, footer.detail)
}

/** Every tool in the window, ranked; each row a click away from its own page. */
export const toolsTable = (h: H, inputs: ToolsTableInputs): Html =>
	h.section(
		[h.AriaLabel("Tools"), h.Class("@container/panel min-w-0 px-6 pt-5 pb-6")],
		[
			h.div(
				[h.Class("flex items-baseline gap-2.5 pb-3 font-mono")],
				[
					h.span([h.Class("text-xs font-medium text-foreground")], ["Tools"]),
					h.span(
						[h.Class("text-2xs leading-3.5 tabular-nums text-foreground-subtle")],
						[formatNumber(inputs.rows.length)],
					),
				],
			),
			toolTable(h, [
				head(h, inputs.sort),
				toolTableBody(h, body(h, inputs), { isWaiting: inputs.isWaiting }),
			]),
			...(inputs.failure === undefined && !inputs.isLoading ? [footerOf(h, inputs.rows)] : []),
		],
	)
