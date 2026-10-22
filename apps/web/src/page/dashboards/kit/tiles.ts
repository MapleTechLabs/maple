// BOUNDARY: tiles render whatever their endpoint answered; rows are untyped query results.
import type { DashboardDocument } from "@maple/domain/http"
import { EMPTY_VALUE, formatValueByUnit } from "@maple/ui/lib/format"
import { shortId } from "@maple/ui/lib/ids"
import { cn } from "@maple/ui/lib/utils"
import { dataSourceTransform } from "@maple/widgets/dashboard"
import { Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import type * as Chart from "../../../charts/chart"
import type { ChartRuntime } from "../../../charts/chart-runtime"
import type { VariableValues } from "@maple/query-engine"
import type { ThemeColors } from "../../../charts/theme-colors"
import { AppRoute, hrefOf } from "../../../route"
import { chartSkeleton } from "../../../ui/chart-skeleton"
import { icon } from "../../../ui/icon"
import { skeletonList } from "../../../ui/skeleton"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import type { WidgetDataState } from "./data-state"
import { renderMarkdown } from "./markdown"
import { widgetEmptyState, widgetFrame, widgetShell } from "./tile-shell"
import { chartWidgetTile, CHART_WIDGETS } from "./tiles-chart"
import { frame, timeRangeLabelOf, titleOf } from "./tiles-frame"
import { gaugeDial } from "./gauge-view"
import { statTile, thresholdColor } from "./tiles-stat"

export { formatStatValue } from "./tiles-stat"

// The tiles: stat, gauge, table, list and note here, every registry
// chart through `chartWidgetTile` (./tiles-chart.ts).

/** What a tile reads of its widget; a share's redacted widget satisfies it too. */
export type TileWidget = Pick<DashboardDocument["widgets"][number], "id" | "display" | "timeRange"> &
	Readonly<{ visualization: string; dataSource: unknown }>
type Widget = TileWidget
type Row = Readonly<Record<string, unknown>>

/** `useTableSort`: per table widget, the active key and direction. */
export const TableSort = Schema.Struct({
	key: Schema.NullOr(Schema.String),
	dir: Schema.Literals(["asc", "desc"]),
})
export type TableSort = typeof TableSort.Type

/** Everything a tile reads besides its widget, and the Messages it sends back. */
export type TileContext<M> = Readonly<{
	h: HtmlBuilder<M>
	state: WidgetDataState
	isEdit: boolean
	menu: Html | null
	isMenuOpen: boolean
	hasGrip: boolean
	configure: M | null
	chart: Chart.Model
	themeColors: ThemeColors | null
	chartRuntime: ChartRuntime
	nowMs: number | null
	timeZone: string
	tableSort: TableSort
	onChart: (message: Chart.Message) => M
	onSort: (field: string, isText: boolean) => M
	/** A stat's trend series (`display.sparkline.dataSource`), or `null` when it has none yet. */
	sparkline?: WidgetDataState | null
	/** The sparkline's own chart slot. */
	sparklineChart?: Chart.Model
	onSparklineChart?: (message: Chart.Message) => M
	/** The board's resolved variables: titles read `$service` as its value (`interpolateDisplayText`). */
	variables?: VariableValues
	/** "Fix with AI" on a decode error, when the surface offers it. */
	fix?: M | null
	/** "Show last 7 days" on a list wider than the cap, when the surface offers narrowing. */
	narrowRange?: M | null
	/** The "Details" popover under a failed tile's message, when the surface renders one. */
	errorDetails?: ((message: string) => Html) | null
}>

// VALUES

/** `formatCellValue`: units format numbers; unitless cells stay raw. */
export const formatCell = (value: unknown, unit?: string): string => {
	if (value === null || value === undefined) return EMPTY_VALUE
	const num = Number(value)
	if (Number.isNaN(num) || unit === undefined || unit === "") return String(value)
	return formatValueByUnit(num, unit)
}

const isNumericCell = (value: unknown): boolean =>
	typeof value === "number" ||
	(typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)))

const COLUMN_VISIBILITY = [
	"",
	"hidden @min-[220px]/widget:table-cell",
	"hidden @min-[320px]/widget:table-cell",
	"hidden @min-[420px]/widget:table-cell",
	"hidden @min-[520px]/widget:table-cell",
	"hidden @min-[620px]/widget:table-cell",
]

const columnVisibilityClass = (index: number): string =>
	COLUMN_VISIBILITY[Math.min(index, COLUMN_VISIBILITY.length - 1)] ?? ""

type Column = Readonly<{
	field: string
	header: string
	unit?: string
	width?: number
	align?: "left" | "center" | "right"
	hidden?: boolean
	thresholds?: ReadonlyArray<{ readonly value: number; readonly color: string }>
}>

const rowsOf = (state: WidgetDataState): ReadonlyArray<Row> =>
	state._tag === "Ready" && state.data !== null && state.data._tag === "Rows" ? state.data.rows : []

const columnsOf = (
	widget: Widget,
	rows: ReadonlyArray<Row>,
	keep: (value: unknown) => boolean,
): ReadonlyArray<Column> => {
	const configured: ReadonlyArray<Column> = widget.display.columns ?? []
	const base =
		configured.length > 0
			? configured
			: Object.keys(rows[0] ?? {})
					.filter((key) => keep(rows[0]?.[key]))
					.map((key): Column => ({ field: key, header: key }))
	return base.filter((column) => column.hidden !== true)
}

/** `compareValues` (use-table-sort.ts). */
const compareValues = (a: unknown, b: unknown, dir: "asc" | "desc"): number => {
	if (
		(typeof a === "number" && typeof b === "number") ||
		(isNumericCell(a) && isNumericCell(b) && typeof a === "string" && typeof b === "string")
	) {
		const an = Number(a)
		const bn = Number(b)
		const cmp = an < bn ? -1 : an > bn ? 1 : 0
		return dir === "asc" ? cmp : -cmp
	}
	return dir === "asc" ? String(a).localeCompare(String(b)) : String(b).localeCompare(String(a))
}

// TILES

const sortableHeader = <M>(h: HtmlBuilder<M>, ctx: TileContext<M>, column: Column, isText: boolean): Html => {
	const sort = ctx.tableSort
	const isActive = sort.key === column.field
	return h.button(
		[
			h.Type("button"),
			h.OnClick(ctx.onSort(column.field, isText)),
			h.Class(
				cn(
					"inline-flex items-center gap-1 transition-colors",
					isActive ? "text-foreground" : "hover:text-foreground",
					cn(
						"max-w-full",
						column.align === "right" && "justify-end",
						!isActive && "text-muted-foreground",
					),
				),
			),
		],
		[
			h.span([h.Class("truncate")], [column.header]),
			icon(h, "ArrowUpDownIcon", {
				size: 10,
				className: cn(
					"shrink-0 transition-opacity",
					isActive ? "opacity-100" : "opacity-40",
					isActive && sort.dir === "asc" && "rotate-180",
				),
			}),
		],
	)
}

const cellStyle = <M>(h: HtmlBuilder<M>, column: Column, extra: Readonly<Record<string, string>> = {}) =>
	h.Style(
		column.width === undefined
			? { "text-align": column.align ?? "left", ...extra }
			: { "text-align": column.align ?? "left", width: `${column.width}px`, ...extra },
	)

/** `TableWidget`: sortable headers, unit-formatted cells, progressive column reveal. */
const tableTile = <M>(h: HtmlBuilder<M>, ctx: TileContext<M>, widget: Widget): Html => {
	const options = frame(ctx, widget, {
		contentClassName: "flex-1 min-h-0 overflow-auto p-0",
		loadingSkeleton: skeletonList(h, { rows: 3, rowClassName: "h-6", gap: "2", className: "p-3" }),
	})
	const rows = rowsOf(options.state)
	const rowLimit = dataSourceTransform(widget.dataSource)?.limit
	const truncated = rowLimit !== undefined && rows.length >= rowLimit
	return widgetFrame(h, { ...options, footer: truncated ? `Top ${rowLimit} rows` : undefined }, () => {
		if (rows.length === 0) return [widgetEmptyState(h)]
		const columns = columnsOf(widget, rows, () => true)
		const sort = ctx.tableSort
		const textFields = Object.keys(rows[0] ?? {}).filter((field) => !isNumericCell(rows[0]?.[field]))
		const sortKey = sort.key
		const sorted =
			sortKey === null ? rows : rows.toSorted((a, b) => compareValues(a[sortKey], b[sortKey], sort.dir))
		return [
			table(h, {}, [
				tableHeader(h, [
					tableRow(
						h,
						columns.map((column, index) =>
							tableHead(
								h,
								[sortableHeader(h, ctx, column, textFields.includes(column.field))],
								cn("text-xs", columnVisibilityClass(index)),
								[
									h.AriaSort(
										sort.key === column.field
											? sort.dir === "asc"
												? "ascending"
												: "descending"
											: "none",
									),
									cellStyle(h, column),
								],
							),
						),
					),
				]),
				tableBody(
					h,
					sorted.map((row) =>
						tableRow(
							h,
							columns.map((column, index) => {
								const value = row[column.field]
								const color = thresholdColor(value, column.thresholds)
								return tableCell(
									h,
									[formatCell(value, column.unit)],
									cn("text-xs", columnVisibilityClass(index)),
									[
										cellStyle(
											h,
											column,
											color === undefined ? {} : { color, "font-weight": "500" },
										),
									],
								)
							}),
						),
					),
				),
			]),
		]
	})
}

/** `resolveFieldPath`: dotted paths, with attribute maps whose keys contain dots. */
const KNOWN_MAP_FIELDS = ["rootSpan.attributes", "logAttributes", "resourceAttributes", "spanAttributes"]

/** One property of an untyped row value, by name. */
const property = (value: unknown, key: string): unknown =>
	value !== null && typeof value === "object"
		? Object.entries(value).find(([name]) => name === key)?.[1]
		: undefined

const nested = (value: unknown, parts: ReadonlyArray<string>): unknown =>
	parts.reduce<unknown>((current, part) => property(current, part), value)

const resolveFieldPath = (row: Row, path: string): unknown => {
	const mapField = KNOWN_MAP_FIELDS.find((field) => path.startsWith(`${field}.`))
	if (mapField === undefined) return nested(row, path.split("."))
	const map = nested(row, mapField.split("."))
	return property(map, path.slice(mapField.length + 1))
}

const listCell = <M>(h: HtmlBuilder<M>, column: Column, index: number, row: Row): Html => {
	const value = resolveFieldPath(row, column.field)
	const display = Array.isArray(value) ? value.join(", ") : formatCell(value, column.unit)
	const className = cn("text-xs", columnVisibilityClass(index))
	const content: Html | string =
		column.field === "traceId" && typeof value === "string" && value !== ""
			? (() => {
					const raw = row.timestamp ?? row.startTime
					const t = typeof raw === "string" ? raw : undefined
					return h.a(
						[
							h.Href(
								hrefOf(
									AppRoute.Trace({ traceId: value, search: t === undefined ? {} : { t } }),
								),
							),
							h.Target("_blank"),
							h.Class(
								"font-mono text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary",
							),
						],
						[shortId(value, "trace")],
					)
				})()
			: column.field === "spanName" && typeof value === "string" && value !== ""
				? h.a(
						[
							h.Href(hrefOf(AppRoute.Traces({ search: { spanNames: [value] } }))),
							h.Target("_blank"),
							h.Class("hover:underline underline-offset-2"),
						],
						[display],
					)
				: display
	return tableCell(h, [content], className, [cellStyle(h, column)])
}

/** `ListWidget`: raw rows, trace ids and span names as links. TODO(list): `TruncatedCell` bodies. */
const listTile = <M>(h: HtmlBuilder<M>, ctx: TileContext<M>, widget: Widget): Html => {
	const options = frame(ctx, widget, {
		contentClassName: "flex-1 min-h-0 overflow-auto p-0",
		loadingSkeleton: skeletonList(h, { rows: 5, rowClassName: "h-6", gap: "2", className: "p-3" }),
	})
	return widgetFrame(h, options, () => {
		const rows = rowsOf(options.state)
		if (rows.length === 0) return [widgetEmptyState(h)]
		const columns = columnsOf(
			widget,
			rows,
			(value) =>
				value === null || value === undefined || typeof value !== "object" || Array.isArray(value),
		)
		return [
			table(h, {}, [
				tableHeader(h, [
					tableRow(
						h,
						columns.map((column, index) =>
							tableHead(h, [column.header], cn("text-xs", columnVisibilityClass(index)), [
								cellStyle(h, column),
							]),
						),
					),
				]),
				tableBody(
					h,
					rows.map((row) =>
						tableRow(
							h,
							columns.map((column, index) => listCell(h, column, index, row)),
						),
					),
				),
			]),
		]
	})
}

/** `MarkdownWidget`: a static note, no data state; empty reads as a prompt to edit. */
const markdownTile = <M>(h: HtmlBuilder<M>, ctx: TileContext<M>, widget: Widget): Html => {
	const content = widget.display.markdown?.content ?? ""
	return widgetShell(
		h,
		{
			widgetId: widget.id,
			title: titleOf(ctx, widget.display.title, "Note"),
			isEdit: ctx.isEdit,
			hasGrip: ctx.hasGrip,
			menu: ctx.menu,
			isMenuOpen: ctx.isMenuOpen,
			timeRangeLabel: timeRangeLabelOf(ctx, widget),
			contentClassName: "flex-1 min-h-0 overflow-auto p-2 @min-[220px]/widget:p-3",
		},
		[
			content.trim() === ""
				? h.div(
						[h.Class("text-xs text-muted-foreground italic")],
						["Empty note. Edit to add markdown content."],
					)
				: h.div([h.Class("text-xs text-foreground space-y-2")], renderMarkdown(h, content)),
		],
	)
}

/** `GaugeWidget`: the segmented dial; one `glowId` per tile, as `useId` gives. */
const gaugeTile = <M>(h: HtmlBuilder<M>, ctx: TileContext<M>, widget: Widget): Html => {
	const options = frame(ctx, widget, {
		contentClassName: "flex-1 min-h-0 flex items-center justify-center p-1 @min-[200px]/widget:p-2",
		loadingSkeleton: chartSkeleton(h, "gauge"),
	})
	return widgetFrame(h, options, () => {
		const data = options.state._tag === "Ready" ? options.state.data : null
		const value = data === null ? undefined : data._tag === "Value" ? data.value : data.rows
		return [
			gaugeDial(h, `gauge-${widget.id}`, value, {
				min: widget.display.gauge?.min,
				max: widget.display.gauge?.max,
				unit: widget.display.unit,
				prefix: widget.display.prefix,
				suffix: widget.display.suffix,
				thresholds: widget.display.thresholds,
			}),
		]
	})
}

/** `visualizationFor(widget.visualization)`. */
export const widgetTile = <M>(h: HtmlBuilder<M>, ctx: TileContext<M>, widget: Widget): Html => {
	switch (widget.visualization) {
		case "stat":
			return statTile(h, ctx, widget)
		case "gauge":
			return gaugeTile(h, ctx, widget)
		case "table":
			return tableTile(h, ctx, widget)
		case "list":
			return listTile(h, ctx, widget)
		case "markdown":
			return markdownTile(h, ctx, widget)
		case "pie":
		case "histogram":
		case "heatmap":
		case "funnel":
		case "paths":
		case "hbar":
			return chartWidgetTile(h, ctx, widget, CHART_WIDGETS[widget.visualization])
		default:
			return chartWidgetTile(h, ctx, widget, CHART_WIDGETS.chart)
	}
}
