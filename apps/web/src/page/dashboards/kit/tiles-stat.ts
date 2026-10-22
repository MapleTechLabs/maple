import { EMPTY_VALUE, formatValueByUnit } from "@maple/ui/lib/format"
import { validateCssColor } from "@maple/ui/lib/sanitizers"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../../charts/chart"
import { isChartRuntimeReady } from "../../../charts/chart-runtime"
import * as Sparkline from "../../../charts/sparkline"
import { resolveColor } from "../../../charts/theme-colors"
import { chartSkeleton } from "../../../ui/chart-skeleton"
import type { WidgetDataState } from "./data-state"
import { widgetFrame } from "./tile-shell"
import type { TileContext, TileWidget } from "./tiles"
import { frame } from "./tiles-frame"

// The stat widget, with its trend sparkline when
// `display.sparkline` names a series (`StatSparkline`).

type Widget = TileWidget

/** The stat's value, formatted. */
export const formatStatValue = (value: unknown, unit?: string, prefix?: string, suffix?: string): string => {
	if (value === null || value === undefined || typeof value === "object") return EMPTY_VALUE
	const num = typeof value === "number" ? value : Number(value)
	if (Number.isNaN(num)) return String(value)
	return `${prefix ?? ""}${formatValueByUnit(num, unit)}${suffix ?? ""}`
}

/** `getThresholdColor`: the highest threshold the value reaches. */
export const thresholdColor = (
	value: unknown,
	thresholds: ReadonlyArray<{ readonly value: number; readonly color: string }> | undefined,
): string | undefined => {
	if (thresholds === undefined || thresholds.length === 0) return undefined
	if (value === null || value === undefined || typeof value === "object") return undefined
	const num = typeof value === "number" ? value : Number(value)
	if (Number.isNaN(num)) return undefined
	return thresholds.toSorted((a, b) => b.value - a.value).find((threshold) => num >= threshold.value)?.color
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

/** `StatSparkline`'s values: the first finite numeric column (not `bucket`) of the series rows. */
export const sparklineValues = (state: WidgetDataState | null | undefined): ReadonlyArray<number> => {
	const rows =
		state?._tag === "Ready" && state.data !== null && state.data._tag === "Rows" ? state.data.rows : []
	const valueKey = rows
		.flatMap((row) =>
			isRecord(row)
				? Object.entries(row).filter(
						([key, value]) =>
							key !== "bucket" && typeof value === "number" && Number.isFinite(value),
					)
				: [],
		)
		.map(([key]) => key)[0]
	if (valueKey === undefined) return []
	return rows.map((row) => {
		const value = isRecord(row) ? row[valueKey] : undefined
		return typeof value === "number" && Number.isFinite(value) ? value : 0
	})
}

/** The trend under the headline; fewer than two points render nothing. */
const sparkline = <M>(h: HtmlBuilder<M>, ctx: TileContext<M>, widget: Widget, color: string): Html => {
	const values = sparklineValues(ctx.sparkline)
	const theme = ctx.themeColors
	if (
		values.length < 2 ||
		theme === null ||
		!isChartRuntimeReady(ctx.chartRuntime) ||
		ctx.onSparklineChart === undefined
	)
		return h.empty
	const stroke = resolveColor(theme, validateCssColor(color) ?? "var(--chart-1)")
	return h.div(
		[h.Class("h-10 w-full shrink-0")],
		[
			h.submodel({
				slotId: `sparkline-${widget.id}`,
				model: ctx.sparklineChart ?? Chart.init(),
				view: Sparkline.view,
				toParentMessage: ctx.onSparklineChart,
				viewInputs: {
					chartId: `spark-${widget.id}`,
					values,
					color: stroke,
					className: "h-full w-full",
					revision: values.length,
					curve: "monotone",
					fillOpacity: [0.35, 0],
				},
			}),
		],
	)
}

const valueText = <M>(h: HtmlBuilder<M>, formatted: string, color: string | undefined): Html =>
	h.span(
		[
			h.Class(
				"min-w-0 max-w-full truncate text-base font-semibold tabular-nums @min-[150px]/widget:text-2xl @min-[280px]/widget:text-3xl",
			),
			...(color === undefined ? [] : [h.Style({ color })]),
			h.Title(formatted),
		],
		[formatted],
	)

export const statTile = <M>(h: HtmlBuilder<M>, ctx: TileContext<M>, widget: Widget): Html => {
	const display = widget.display
	const hasSparkline = display.sparkline?.enabled === true && display.sparkline.dataSource !== undefined
	const options = frame(ctx, widget, {
		contentClassName: hasSparkline
			? "flex-1 min-h-0 flex flex-col"
			: "flex-1 min-h-0 flex items-center justify-center p-2 @min-[200px]/widget:p-4",
		loadingSkeleton: hasSparkline
			? h.div(
					[h.Class("flex h-full w-full flex-col")],
					[
						h.div(
							[h.Class("flex flex-1 items-center justify-center")],
							[chartSkeleton(h, "stat")],
						),
						chartSkeleton(h, "line", "h-10 shrink-0"),
					],
				)
			: chartSkeleton(h, "stat"),
	})
	return widgetFrame(h, options, () => {
		const data = options.state._tag === "Ready" ? options.state.data : null
		const value = data === null ? undefined : data._tag === "Value" ? data.value : data.rows
		const formatted = formatStatValue(value, display.unit, display.prefix, display.suffix)
		const color = thresholdColor(value, display.thresholds)
		return hasSparkline
			? [
					h.div(
						[
							h.Class(
								"flex flex-1 items-center justify-center px-2 pt-2 @min-[200px]/widget:px-4 @min-[200px]/widget:pt-4",
							),
						],
						[valueText(h, formatted, color)],
					),
					h.div(
						[h.Class("hidden shrink-0 @min-[140px]/widget:block")],
						[sparkline(h, ctx, widget, color ?? "var(--chart-1)")],
					),
				]
			: [valueText(h, formatted, color)]
	})
}
