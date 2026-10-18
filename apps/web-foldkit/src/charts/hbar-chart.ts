import { pickValueField, toBreakdownRows } from "@maple/ui/components/charts/_shared/breakdown-rows"
import { formatNumber, formatPercent, formatValueByUnit } from "@maple/ui/lib/format"
import { resolveSeriesColors } from "@maple/ui/lib/semantic-series-colors"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { truncatedText } from "../ui/truncated-text"

// Port of `QueryBuilderHbarChart` (packages/ui/src/components/charts/hbar/): ranked horizontal bars,
// each a share of the total. Rows divide the container's height, which the caller passes in (legacy
// measures it); a list taller than the card scrolls with a "+N more" footer.
// TODO(hbar-hover): the hovered row's emphasis (others fade to 0.55) is not ported.

const ROW_GAP = 6
const ROW_MIN_H = 18
const ROW_FULL_H = ROW_MIN_H + ROW_GAP
const ROW_MAX_H = 56
const BAR_MIN_THICKNESS = 10
const BAR_MAX_THICKNESS = 20
const BAR_MIN_PCT = 0.02
const MORE_ROW_H = 16

export type HbarChartOptions = Readonly<{
	rows: ReadonlyArray<Readonly<Record<string, string | number>>>
	/** The container's height in px (`useContainerSize`); 0 before it is known. */
	height: number
	unit?: string
	className?: string
}>

const fmtValue = (value: number, unit: string | undefined): string =>
	unit === undefined || unit === "" ? formatNumber(value) : formatValueByUnit(value, unit)

export const hbarChart = <M>(h: HtmlBuilder<M>, options: HbarChartOptions): Html => {
	const valueField = pickValueField(options.rows)
	const rows = toBreakdownRows(options.rows, valueField)
		.filter((row) => row.value > 0)
		.toSorted((a, b) => b.value - a.value)
	const max = rows[0]?.value ?? 0
	const total = rows.reduce((acc, row) => acc + row.value, 0)
	if (max <= 0)
		return h.div(
			[h.Class(cn("relative h-full w-full grid place-items-center", options.className))],
			[h.span([h.Class("text-2xs text-muted-foreground")], ["No data"])],
		)
	const colors = resolveSeriesColors(rows.map((row) => row.name))
	const height = options.height
	const maxRows = height > 0 ? Math.max(1, Math.floor((height - MORE_ROW_H) / ROW_FULL_H)) : rows.length
	const truncated = rows.length > maxRows
	const hiddenCount = truncated ? Math.max(0, rows.length - Math.floor((height - MORE_ROW_H + ROW_GAP) / ROW_FULL_H)) : 0
	const rowH =
		height > 0 && !truncated
			? Math.min(ROW_MAX_H, Math.max(ROW_MIN_H, (height - ROW_GAP * (rows.length - 1)) / rows.length))
			: ROW_MIN_H
	const barH = Math.round(
		BAR_MIN_THICKNESS + ((BAR_MAX_THICKNESS - BAR_MIN_THICKNESS) * (rowH - ROW_MIN_H)) / (ROW_MAX_H - ROW_MIN_H),
	)
	return h.div(
		[h.Class(cn("relative h-full w-full select-none", options.className))],
		[
			h.div(
				[
					h.Class(
						cn(
							"flex h-full w-full flex-col justify-start px-1",
							truncated ? "overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" : "overflow-hidden",
						),
					),
					h.Style({ "row-gap": `${ROW_GAP}px`, "padding-bottom": `${truncated ? MORE_ROW_H : 0}px` }),
					h.DataAttribute("slot", "hbar-rows"),
				],
				rows.map((row) =>
					h.div(
						[
							h.Class("grid min-h-0 shrink-0 items-center gap-2 text-2xs leading-none"),
							h.Style({ "grid-template-columns": "minmax(0, 38%) 1fr max-content", height: `${rowH}px` }),
						],
						[
							truncatedText(
								h,
								{ text: row.name, className: row.unnamed ? "italic text-muted-foreground" : "text-foreground/90" },
								[row.name],
							),
							h.div(
								[h.Class("relative w-full overflow-hidden rounded-[3px] bg-foreground/5"), h.Style({ height: `${barH}px` })],
								[
									h.div([
										h.Class("absolute inset-y-0 left-0 rounded-[3px]"),
										h.Style({
											width: `${Math.max(BAR_MIN_PCT, row.value / max) * 100}%`,
											"background-color": colors.get(row.name) ?? "",
											opacity: "1",
											transition: "opacity 140ms ease, width 220ms ease",
										}),
									]),
								],
							),
							h.span(
								[h.Class("shrink-0 text-right tabular-nums text-muted-foreground")],
								[
									h.span([h.Class("text-foreground/90")], [fmtValue(row.value, options.unit)]),
									h.span([h.Class("px-1 text-muted-foreground/50")], ["·"]),
									h.span([], [formatPercent(total > 0 ? row.value / total : 0, { floor: 0.001 })]),
								],
							),
						],
					),
				),
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
							[h.span([h.Class("pb-px")], ["+", String(hiddenCount), " more · scroll"])],
						),
					]
				: []),
		],
	)
}
