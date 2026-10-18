// BOUNDARY: tiles render whatever their endpoint answered; rows are untyped query results.
import type { DashboardDocument } from "@maple/domain/http"
import { EMPTY_VALUE, formatValueByUnit } from "@maple/ui/lib/format"
import { shortId } from "@maple/ui/lib/ids"
import { cn } from "@maple/ui/lib/utils"
import { dataSourceTransform } from "@maple/widgets/dashboard"
import { Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as AreaChart from "../../../charts/area-chart"
import type * as Chart from "../../../charts/chart"
import { type ChartRuntime, isChartRuntimeReady } from "../../../charts/chart-runtime"
import type { ThemeColors } from "../../../charts/theme-colors"
import { AppRoute, hrefOf } from "../../../route"
import { chartSkeleton } from "../../../ui/chart-skeleton"
import { icon } from "../../../ui/icon"
import { skeletonList } from "../../../ui/skeleton"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import { chartCategoryOf } from "./chart-registry"
import type { WidgetDataState } from "./data-state"
import { widgetEmptyState, widgetFrame, type FrameOptions } from "./tile-shell"
import type { ReadyData } from "./widget-data"

// The tiles: `StatWidget`, `TableWidget`, `ListWidget` and the time-series `ChartWidget`
// (dashboard-builder/widgets/*). TODO(widget-types): gauge, pie, bar, histogram, heatmap, funnel,
// paths and markdown tiles render their frame with a "not ported" note.

type Widget = DashboardDocument["widgets"][number]
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
}>

// VALUES

/** `formatValue` (stat-widget.tsx). */
const formatStatValue = (value: unknown, unit?: string, prefix?: string, suffix?: string): string => {
	if (value === null || value === undefined || typeof value === "object") return EMPTY_VALUE
	const num = typeof value === "number" ? value : Number(value)
	if (Number.isNaN(num)) return String(value)
	return `${prefix ?? ""}${formatValueByUnit(num, unit)}${suffix ?? ""}`
}

/** `getThresholdColor`: the highest threshold the value reaches. */
const thresholdColor = (
	value: unknown,
	thresholds: ReadonlyArray<{ readonly value: number; readonly color: string }> | undefined,
): string | undefined => {
	if (thresholds === undefined || thresholds.length === 0) return undefined
	if (value === null || value === undefined || typeof value === "object") return undefined
	const num = typeof value === "number" ? value : Number(value)
	if (Number.isNaN(num)) return undefined
	return thresholds.toSorted((a, b) => b.value - a.value).find((threshold) => num >= threshold.value)?.color
}

/** `formatCellValue`: units format numbers; unitless cells stay raw. */
const formatCell = (value: unknown, unit?: string): string => {
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

const frame = <M>(
	ctx: TileContext<M>,
	widget: Widget,
	overrides: Partial<FrameOptions<M>>,
): FrameOptions<M> => ({
	widgetId: widget.id,
	title:
		widget.display.title !== undefined && widget.display.title !== "" ? widget.display.title : "Untitled",
	isEdit: ctx.isEdit,
	hasGrip: ctx.hasGrip,
	menu: ctx.menu,
	isMenuOpen: ctx.isMenuOpen,
	contentClassName: undefined,
	state: ctx.state,
	loadingSkeleton: chartSkeleton(ctx.h, "line"),
	configure: ctx.configure,
	...overrides,
})

/** `StatWidget` without a sparkline. TODO(sparkline): the stat trend line is not ported. */
const statTile = <M>(h: HtmlBuilder<M>, ctx: TileContext<M>, widget: Widget): Html => {
	const options = frame(ctx, widget, {
		contentClassName: "flex-1 min-h-0 flex items-center justify-center p-2 @min-[200px]/widget:p-4",
		loadingSkeleton: statSkeleton(h),
	})
	return widgetFrame(h, options, () => {
		const data = options.state._tag === "Ready" ? options.state.data : null
		const value = data === null ? undefined : data._tag === "Value" ? data.value : data.rows
		const formatted = formatStatValue(
			value,
			widget.display.unit,
			widget.display.prefix,
			widget.display.suffix,
		)
		const color = thresholdColor(value, widget.display.thresholds)
		return [
			h.span(
				[
					h.Class(
						"min-w-0 max-w-full truncate text-base font-semibold tabular-nums @min-[150px]/widget:text-2xl @min-[280px]/widget:text-3xl",
					),
					...(color === undefined ? [] : [h.Style({ color })]),
					h.Title(formatted),
				],
				[formatted],
			),
		]
	})
}

/** `ChartSkeleton variant="stat"`. */
const statSkeleton = <M>(h: HtmlBuilder<M>): Html =>
	h.div(
		[
			h.Class("flex h-full w-full flex-col items-center justify-center gap-2"),
			h.DataAttribute("slot", "chart-skeleton"),
			h.AriaHidden(true),
		],
		[
			h.div([h.Class("h-8 w-24 animate-pulse rounded-md bg-muted")]),
			h.div([h.Class("h-3 w-16 animate-pulse rounded-md bg-muted/70")]),
		],
	)

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

const chartRows = (
	data: ReadyData | null,
): ReadonlyArray<Readonly<Record<string, string | number | boolean>>> =>
	data === null || data._tag !== "Rows"
		? []
		: data.rows.map((row) =>
				Object.fromEntries(
					Object.entries(row).flatMap(([key, value]) =>
						typeof value === "string" || typeof value === "number" || typeof value === "boolean"
							? [[key, value] as const]
							: [],
					),
				),
			)

/** `ChartWidget` for the line and area charts; the legend hoist (`legend="hidden"`) is not ported. */
const chartTile = <M>(h: HtmlBuilder<M>, ctx: TileContext<M>, widget: Widget): Html => {
	const category = chartCategoryOf(widget.display.chartId ?? "query-builder-line") ?? "line"
	const isSupported = category === "line" || category === "area"
	const options = frame(ctx, widget, {
		loadingSkeleton: chartSkeleton(h, category === "area" ? "area" : "line"),
	})
	return widgetFrame(h, options, () => {
		const data = options.state._tag === "Ready" ? options.state.data : null
		const rows = chartRows(data)
		if (rows.length === 0) return [widgetEmptyState(h)]
		const theme = ctx.themeColors
		if (!isSupported || theme === null || !isChartRuntimeReady(ctx.chartRuntime) || ctx.nowMs === null)
			return [chartSkeleton(h, category === "area" ? "area" : "line")]
		const presentation = widget.display.chartPresentation
		return [
			h.submodel({
				slotId: `chart-${widget.id}`,
				model: ctx.chart,
				view: AreaChart.view,
				toParentMessage: ctx.onChart,
				viewInputs: {
					chartId: widget.id,
					data: rows,
					theme,
					unit: widget.display.unit,
					timeZone: ctx.timeZone,
					nowMs: ctx.nowMs,
					className: "h-full w-full aspect-auto",
					showTooltip: presentation?.tooltip !== "hidden",
					legend:
						presentation?.legend === "visible" || presentation?.legend === "right"
							? presentation.legend
							: "hidden",
					mark: category === "line" ? "line" : "area",
					stacked: widget.display.stacked === true,
					curveType: widget.display.curveType === "monotone" ? "monotone" : "linear",
					...(presentation?.showPoints === undefined
						? undefined
						: { showPoints: presentation.showPoints }),
					seriesStats: presentation?.seriesStats === true,
				},
			}),
		]
	})
}

const unsupportedTile = <M>(h: HtmlBuilder<M>, ctx: TileContext<M>, widget: Widget): Html =>
	widgetFrame(h, frame(ctx, widget, {}), () => [
		h.div(
			[h.Class("flex h-full items-center justify-center text-xs text-muted-foreground")],
			[`${widget.visualization} tiles are not ported yet`],
		),
	])

/** `visualizationFor(widget.visualization)`. */
export const widgetTile = <M>(h: HtmlBuilder<M>, ctx: TileContext<M>, widget: Widget): Html => {
	switch (widget.visualization) {
		case "stat":
			return statTile(h, ctx, widget)
		case "table":
			return tableTile(h, ctx, widget)
		case "list":
			return listTile(h, ctx, widget)
		case "chart":
			return chartTile(h, ctx, widget)
		default:
			return unsupportedTile(h, ctx, widget)
	}
}
