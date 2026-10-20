import { EMPTY_VALUE, formatNumber } from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"
import { listFooter } from "../../../ui/list-footer"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import { tableSkeleton } from "../../../ui/table-skeleton"
import { truncatedText } from "../../../ui/truncated-text"
import { serviceDot } from "../../../ui/values"
import { metricTypeBadge, type MetricRow } from "../shared"
import { Message } from "./message"
import type { Model } from "./model"
import { metricLink } from "./update"
import { relativeTime } from "../../kit/relative-time"

type H = HtmlBuilder<Message>

// A row link stretched over its row, and the lift for controls above it.
const ROW_STRETCHED_LINK_CLASS =
	"after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:ring-1 focus-visible:after:ring-ring focus-visible:after:ring-inset"
const ROW_LINK_LIFT = "relative z-10"

const MD_CELL = "hidden md:table-cell"

export const loadingTable = (h: H): Html =>
	tableSkeleton(h, {
		columns: [
			{ header: "Metric name", headClassName: "w-[40%]", skeleton: "w-48" },
			{
				header: "Type",
				headClassName: `${MD_CELL} w-[100px]`,
				cellClassName: MD_CELL,
				skeleton: "w-16",
			},
			{
				header: "Service",
				headClassName: `${MD_CELL} w-[120px]`,
				cellClassName: MD_CELL,
				skeleton: "w-20",
			},
			{
				header: "Points",
				headClassName: `${MD_CELL} w-[100px]`,
				cellClassName: MD_CELL,
				skeleton: "w-12",
			},
			{
				header: "Last seen",
				headClassName: `${MD_CELL} w-[100px]`,
				cellClassName: MD_CELL,
				skeleton: "w-16",
			},
		],
		rows: 10,
		tableClassName: "table-fixed",
	})

const metricRow = (h: H, model: Model, metric: MetricRow, timeZone: string): Html =>
	tableRow(
		h,
		[
			tableCell(h, [
				h.div(
					[h.Class("flex min-w-0 flex-col gap-0.5")],
					[
						h.a(
							[
								h.Href(metricLink(model, metric.metricName, metric.metricType)),
								h.Class(cn("block min-w-0", ROW_STRETCHED_LINK_CLASS)),
							],
							[
								truncatedText(h, {
									text: metric.metricName,
									mono: true,
									className: cn("text-xs", ROW_LINK_LIFT),
								}),
							],
						),
						...(metric.metricDescription === ""
							? []
							: [
									h.span(
										[h.Class("text-3xs text-muted-foreground line-clamp-1")],
										[metric.metricDescription],
									),
								]),
					],
				),
			]),
			tableCell(h, [metricTypeBadge(h, metric.metricType)], MD_CELL),
			tableCell(
				h,
				[
					metric.serviceName === ""
						? h.span([h.Class("text-xs text-muted-foreground")], [EMPTY_VALUE])
						: badge(
								h,
								{
									variant: "outline",
									size: "xs",
									mono: true,
									className: "max-w-full",
									attributes: [h.Title(metric.serviceName)],
								},
								[
									serviceDot(h, { serviceName: metric.serviceName, size: "sm" }),
									h.span([h.Class("min-w-0 truncate")], [metric.serviceName]),
								],
							),
				],
				`${MD_CELL} overflow-hidden`,
			),
			tableCell(h, [formatNumber(metric.dataPointCount)], `${MD_CELL} font-mono text-xs`),
			tableCell(
				h,
				[relativeTime(h, { value: metric.lastSeen, nowMs: model.nowMs, timeZone, tooltip: "title" })],
				`${MD_CELL} text-xs text-muted-foreground`,
			),
		],
		"hover:bg-muted/50",
	)

/** The loaded table: rows up to `tableLimit`, dimmed while the next page loads. */
export const metricsTable = (
	h: H,
	model: Model,
	rows: ReadonlyArray<MetricRow>,
	isWaiting: boolean,
	timeZone: string,
): Html => {
	const metrics = rows.slice(0, model.tableLimit)
	const hasMore = rows.length > model.tableLimit
	return h.div(
		[h.Class(cn("space-y-4", refreshingClass(isWaiting))), ...(isWaiting ? [h.AriaBusy(true)] : [])],
		[
			h.div(
				[h.Class("rounded-md border overflow-auto")],
				[
					table(h, { className: "table-fixed" }, [
						tableHeader(h, [
							tableRow(h, [
								tableHead(h, ["Metric name"], "w-[40%]"),
								tableHead(h, ["Type"], "w-[100px]"),
								tableHead(h, ["Service"], "w-[120px]"),
								tableHead(h, ["Points"], "w-[100px]"),
								tableHead(h, ["Last seen"], "w-[100px]"),
							]),
						]),
						tableBody(
							h,
							metrics.map((metric) => metricRow(h, model, metric, timeZone)),
						),
					]),
				],
			),
			listFooter(h, {
				shown: metrics.length,
				noun: "metrics",
				hasMore,
				isLoading: isWaiting,
				onLoadMore: Message.ClickedLoadMoreTable(),
				align: "start",
				className: "justify-start p-0 text-sm",
			}) ?? h.empty,
		],
	)
}
