import { pickValueField, toBreakdownRows } from "@maple/ui/components/charts/_shared/breakdown-rows"
import { formatNumber, formatPercent, formatValueByUnit } from "@maple/ui/lib/format"
import { resolveSeriesColors } from "@maple/ui/lib/semantic-series-colors"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { Submodel } from "foldkit"
import { truncatedText } from "../ui/truncated-text"
import { Message, type Model } from "./chart"
import { MeasureChartContainer } from "./chart-mounts"

// Port of `QueryBuilderHbarChart` (packages/ui/src/components/charts/hbar/query-builder-hbar-chart.tsx):
// ranked DOM bars sized from the measured card. The hovered row is the chart Model's `activeKey`.

export interface HbarChartInputs {
	readonly data: ReadonlyArray<Record<string, unknown>>
	readonly className?: string | undefined
	readonly unit?: string | undefined
}

const fmtValue = (value: number, unit?: string): string =>
	unit !== undefined && unit !== "" ? formatValueByUnit(value, unit) : formatNumber(value)

const PCT_FLOOR = { floor: 0.001 }
const ROW_GAP = 6
const ROW_MIN_H = 18
const ROW_FULL_H = ROW_MIN_H + ROW_GAP
const ROW_MAX_H = 56
const BAR_MIN_THICKNESS = 10
const BAR_MAX_THICKNESS = 20
const BAR_MIN_PCT = 0.02
const MORE_ROW_H = 16

export const hbarBars = (source: ReadonlyArray<Record<string, unknown>>) => {
	const rows = toBreakdownRows(source, pickValueField(source))
		.filter((row) => row.value > 0)
		.sort((a, b) => b.value - a.value)
	const max = rows[0]?.value ?? 0
	const total = rows.reduce((acc, row) => acc + row.value, 0)
	if (max <= 0) return []
	const colors = resolveSeriesColors(rows.map((row) => row.name))
	return rows.map((row) => ({
		...row,
		color: colors.get(row.name) ?? "",
		widthPct: Math.max(BAR_MIN_PCT, row.value / max),
		pctOfTotal: total > 0 ? row.value / total : 0,
	}))
}

export const view = Submodel.defineView<Model, Message, HbarChartInputs>((model, inputs, h) => {
	const bars = hbarBars(inputs.data)
	if (bars.length === 0)
		return h.div(
			[h.Class(cn("relative h-full w-full grid place-items-center", inputs.className))],
			[h.span([h.Class("text-2xs text-muted-foreground")], ["No data"])],
		)
	const height = model.containerHeight
	const maxRows = height > 0 ? Math.max(1, Math.floor((height - MORE_ROW_H) / ROW_FULL_H)) : bars.length
	const truncated = bars.length > maxRows
	// TODO(hbar-scroll): the "+N more" count does not follow the inner scroll position.
	const hiddenCount = truncated
		? Math.max(0, bars.length - Math.floor((height - MORE_ROW_H + ROW_GAP) / ROW_FULL_H))
		: 0
	const rowH =
		height > 0 && !truncated
			? Math.min(ROW_MAX_H, Math.max(ROW_MIN_H, (height - ROW_GAP * (bars.length - 1)) / bars.length))
			: ROW_MIN_H
	const barH = Math.round(
		BAR_MIN_THICKNESS +
			((BAR_MAX_THICKNESS - BAR_MIN_THICKNESS) * (rowH - ROW_MIN_H)) / (ROW_MAX_H - ROW_MIN_H),
	)
	const hover = Option.getOrNull(model.activeKey)
	return h.div(
		[
			h.Class(cn("relative h-full w-full select-none", inputs.className)),
			h.OnMount(MeasureChartContainer()),
			h.OnMouseLeave(Message.LeftChart()),
		],
		[
			h.div(
				[
					h.Class(
						cn(
							"flex h-full w-full flex-col justify-start px-1",
							truncated
								? "overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
								: "overflow-hidden",
						),
					),
					h.Style({
						"row-gap": `${ROW_GAP}px`,
						"padding-bottom": `${truncated ? MORE_ROW_H : 0}px`,
					}),
					h.DataAttribute("slot", "hbar-rows"),
				],
				bars.map((bar, i) => {
					const key = String(i)
					const fade = hover !== null && hover !== key ? 0.55 : 1
					return h.div(
						[
							h.Class("grid min-h-0 shrink-0 items-center gap-2 text-2xs leading-none"),
							h.Style({
								"grid-template-columns": "minmax(0, 38%) 1fr max-content",
								height: `${rowH}px`,
							}),
							h.OnMouseEnter(Message.EnteredLegendItem({ key })),
						],
						[
							truncatedText(h, {
								text: bar.name,
								className: bar.unnamed ? "italic text-muted-foreground" : "text-foreground-soft",
							}),
							h.div(
								[
									h.Class("relative w-full overflow-hidden rounded-[3px] bg-foreground/5"),
									h.Style({ height: `${barH}px` }),
								],
								[
									h.div([
										h.Class("absolute inset-y-0 left-0 rounded-[3px]"),
										h.Style({
											width: `${bar.widthPct * 100}%`,
											"background-color": bar.color,
											opacity: String(fade),
											transition: "opacity 140ms ease, width 220ms ease",
										}),
									]),
								],
							),
							h.span(
								[h.Class("shrink-0 text-right tabular-nums text-muted-foreground")],
								[
									h.span([h.Class("text-foreground-soft")], [fmtValue(bar.value, inputs.unit)]),
									h.span([h.Class("px-1 text-foreground-faint")], ["·"]),
									h.span([], [formatPercent(bar.pctOfTotal, PCT_FLOOR)]),
								],
							),
						],
					)
				}),
			),
			...(hiddenCount > 0
				? [
						h.div(
							[
								h.Class(
									"pointer-events-none absolute inset-x-0 bottom-0 flex items-end bg-gradient-to-t from-card via-card/90 to-transparent px-1 pt-4 text-3xs leading-none text-muted-foreground",
								),
								h.Style({ height: `${MORE_ROW_H + 16}px` }),
								h.DataAttribute("slot", "hbar-more"),
							],
							[h.span([h.Class("pb-px")], [`+${hiddenCount} more · scroll`])],
						),
					]
				: []),
		],
	)
})
