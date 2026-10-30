import { DEFAULT_HEATMAP_COLOR_SCALE, type HeatmapColorScale } from "@maple/domain/http"
import { countLabel } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import type { Message, Model } from "./chart"
import { MeasureChartContainer } from "./chart-mounts"
import { ChartSpec, ChartTooltip } from "./chart-spec"
import { FOOTNOTE_BLOCK_H, solveHeatmapLayout } from "./heatmap-layout"
import { heatmapLegend } from "./heatmap-legend"
import {
	buildHeatmapModel,
	deriveHeatmapPoints,
	formatScalar,
	ISO_RE,
	shortenYLabel,
	truncateYLabel,
} from "./heatmap-model"
import { plotFrame } from "./plot-frame"
import { sequentialColorScale } from "./sequential-colors"
import { resolveColor, type ThemeColors } from "./theme-colors"

// Port of `QueryBuilderHeatmapChart` (packages/ui/src/components/charts/heatmap/
// query-builder-heatmap-chart.tsx). The definition is ./definitions/heatmap.ts.

export interface HeatmapChartInputs {
	readonly chartId: string
	readonly data: ReadonlyArray<Record<string, unknown>>
	readonly theme: ThemeColors
	readonly className?: string | undefined
	readonly tooltip?: "visible" | "hidden" | undefined
	readonly unit?: string | undefined
	readonly colorScale?: string | undefined
	readonly scaleType?: "linear" | "log" | undefined
	readonly timeZone?: string | undefined
}

type H = HtmlBuilder<Message>

const SCALES = ["amber", "blues", "reds", "viridis", "magma", "cividis"] as const
const FALLBACKS = {
	amber: ["oklch(0.32 0.035 70)", "oklch(0.45 0.075 65)", "oklch(0.58 0.115 60)", "oklch(0.71 0.15 57)", "oklch(0.85 0.13 78)"],
	blues: ["oklch(0.32 0.04 255)", "oklch(0.45 0.08 252)", "oklch(0.58 0.12 250)", "oklch(0.71 0.15 248)", "oklch(0.85 0.11 238)"],
	reds: ["oklch(0.32 0.045 28)", "oklch(0.45 0.09 28)", "oklch(0.58 0.14 28)", "oklch(0.71 0.185 30)", "oklch(0.85 0.135 45)"],
	viridis: ["oklch(0.32 0.055 285)", "oklch(0.45 0.095 265)", "oklch(0.58 0.09 200)", "oklch(0.71 0.135 150)", "oklch(0.85 0.17 112)"],
	magma: ["oklch(0.32 0.06 300)", "oklch(0.45 0.12 312)", "oklch(0.58 0.175 350)", "oklch(0.71 0.16 35)", "oklch(0.85 0.115 80)"],
	cividis: ["oklch(0.32 0.045 262)", "oklch(0.45 0.055 250)", "oklch(0.58 0.03 130)", "oklch(0.71 0.075 95)", "oklch(0.85 0.13 95)"],
} satisfies Readonly<Record<(typeof SCALES)[number], readonly [string, string, string, string, string]>>
const GROUT_FALLBACK = "oklch(0.175 0.008 62)"

/** Every custom property the heatmap reads; a page resolves them with `ResolveThemeColors`. */
export const HEATMAP_TOKENS: ReadonlyArray<string> = [
	...SCALES.flatMap((scale) => [0, 1, 2, 3, 4].map((index) => `--heatmap-${scale}-${index}`)),
	"--heatmap-grout",
	"--foreground",
]

const isKnownScale = (value: string): value is HeatmapColorScale & (typeof SCALES)[number] =>
	SCALES.some((scale) => scale === value)

const rampStops = (theme: ThemeColors, scale: (typeof SCALES)[number]): ReadonlyArray<string> =>
	FALLBACKS[scale].map((fallback, index) => resolveColor(theme, `--heatmap-${scale}-${index}`, fallback))

const grout = (theme: ThemeColors) => resolveColor(theme, "--heatmap-grout", GROUT_FALLBACK)

/** The quiet placeholder: a tiny suggestive grid with three tinted cells. */
const emptyState = (h: H, inputs: HeatmapChartInputs): Html => {
	const amber = rampStops(inputs.theme, "amber")
	return h.div(
		[h.Class(cn("relative h-full w-full", inputs.className))],
		[
			h.div(
				[h.Class("absolute inset-0 grid place-items-center")],
				[
					h.div(
						[h.Class("flex flex-col items-center gap-2.5")],
						[
							h.div(
								[
									h.Class("grid grid-cols-8 gap-0.5 rounded-sm p-[3px]"),
									h.Style({ background: grout(inputs.theme) }),
								],
								Array.from({ length: 32 }, (_, i) =>
									h.div([
										h.Class("size-1.5 rounded-[1px]"),
										h.Style({
											background:
												i === 11
													? (amber[1] ?? "")
													: i === 12
														? (amber[3] ?? "")
														: i === 20
															? (amber[2] ?? "")
															: "color-mix(in oklch, var(--foreground) 8%, transparent)",
										}),
									]),
								),
							),
							h.div([h.Class("text-2xs text-muted-foreground")], ["No data"]),
						],
					),
				],
			),
		],
	)
}

const tooltipBody = (
	h: H,
	tooltip: ChartTooltip,
	colorAt: (value: number) => string,
	label: (y: string) => string,
	unit: string | undefined,
	portal: Attribute<Message>,
): Option.Option<Html> =>
	tooltip._tag !== "HeatmapSlot"
		? Option.none()
		: Option.some(
				h.div(
					[h.Class("contents"), portal],
					[
						h.div(
							[h.Class("text-muted-foreground")],
							[
								h.span([], [tooltip.x]),
								h.span([h.Class("px-1 text-foreground-faint")], ["·"]),
								h.span([], [label(tooltip.y)]),
							],
						),
						h.div(
							[h.Class("mt-1 flex items-center gap-1.5")],
							tooltip.value === null
								? [h.span([h.Class("italic text-muted-foreground")], ["no data"])]
								: [
										h.span([
											h.Class("size-2 shrink-0 rounded-xs"),
											h.Style({ "background-color": colorAt(tooltip.value) }),
										]),
										h.span(
											[h.Class("font-medium tabular-nums text-foreground")],
											[formatScalar(tooltip.value, unit)],
										),
									],
						),
					],
				),
			)

const footnoteOf = (hiddenX: number, hiddenY: number): string | null =>
	hiddenX > 0 || hiddenY > 0
		? `${[
				hiddenX > 0 ? countLabel(hiddenX, "empty column") : null,
				hiddenY > 0 ? countLabel(hiddenY, "empty row") : null,
			]
				.filter((part) => part !== null)
				.join(" · ")} hidden`
		: null

export const view = Submodel.defineView<Model, Message, HeatmapChartInputs>((chart, inputs, h) => {
	const model = buildHeatmapModel(deriveHeatmapPoints(inputs.data))
	if (model.xDomain.length === 0 || model.yDomain.length === 0) return emptyState(h, inputs)
	const requested = inputs.colorScale ?? DEFAULT_HEATMAP_COLOR_SCALE
	const palette = isKnownScale(requested) ? requested : "amber"
	const scaleType = inputs.scaleType ?? "linear"
	const stops = rampStops(inputs.theme, palette)
	const colorAt = sequentialColorScale({ stops, domain: model.domain, scaleType })
	const allYIso = model.yDomain.every((value) => ISO_RE.test(value))
	const label = (y: string) => shortenYLabel(y, allYIso, inputs.timeZone)
	const footnote = footnoteOf(model.hiddenX, model.hiddenY)
	const layout = solveHeatmapLayout({
		containerW: chart.containerWidth,
		containerH: chart.containerHeight,
		columns: model.xDomain.length,
		rows: model.yDomain.length,
		longestYLabelChars: model.yDomain.reduce((longest, value) => Math.max(longest, label(value).length), 0),
		hasFootnote: footnote !== null,
	})
	const hoveredKey = Option.getOrNull(chart.activeKey)
	const hovered =
		hoveredKey === null
			? null
			: ([...model.cells, ...model.holes].find((slot) => `${slot.x}\u0000${slot.y}` === hoveredKey)?.value ??
				null)
	const spec = ChartSpec.Heatmap({
		cells: model.cells,
		holes: model.holes,
		xDomain: model.xDomain,
		yDomain: model.yDomain,
		yLabels: Object.fromEntries(
			model.yDomain.map((y) => [y, truncateYLabel(label(y), layout.yLabelChars)]),
		),
		margin: layout.margin,
		paddingInnerX: layout.paddingInnerX,
		paddingInnerY: layout.paddingInnerY,
		radius: layout.radius,
		stops,
		domain: model.domain,
		scaleType,
		grout: grout(inputs.theme),
		foreground: resolveColor(inputs.theme, "--foreground"),
		showTooltip: inputs.tooltip !== "hidden",
	})
	return h.div(
		[
			h.Class(cn("relative h-full w-full select-none", inputs.className)),
			h.Style({ animation: "tile-in 0.35s ease both" }),
			h.OnMount(MeasureChartContainer()),
		],
		[
			plotFrame(h, {
				chartId: inputs.chartId,
				className: "h-full w-full",
				ariaLabel: "Heatmap",
				spec,
				legend: heatmapLegend(h, {
					domain: model.domain,
					span: model.span,
					scaleType,
					colorAt,
					unit: inputs.unit,
					hovered,
					insetLeft: layout.gutter,
					insetRight: layout.rightInset,
				}),
				...(footnote === null
					? undefined
					: {
							footer: h.p(
								[
									h.Class("pt-1 text-right text-3xs leading-3 tabular-nums text-foreground-subtle"),
									h.Style({
										height: `${FOOTNOTE_BLOCK_H}px`,
										"padding-left": `${layout.gutter}px`,
										"padding-right": `${layout.rightInset}px`,
									}),
								],
								[footnote],
							),
						}),
				tooltipBody: (portal) =>
					Option.flatMap(chart.tooltip, (tooltip) =>
						tooltipBody(h, tooltip, colorAt, label, inputs.unit, portal),
					),
			}),
		],
	)
})
