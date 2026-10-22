import type { Html, HtmlBuilder } from "foldkit/html"
import { LEGEND_BLOCK_H } from "./heatmap-layout"
import { formatScalar, rampPositionOf, roundTick, valueAtRampPosition } from "./heatmap-model"
import type { SequentialScaleType } from "./sequential-domain"

// `HeatmapLegend`: five stepped swatches with values read back through the ramp, a marker at the
// hovered value, and insets that line the bar up with the plot's columns.

const LEGEND_STEPS = 5
const LEGEND_BAR_H = 8
const LEGEND_FONT_PX = 10

export type HeatmapLegendInputs = Readonly<{
	domain: readonly [number, number]
	span: number
	scaleType: SequentialScaleType
	colorAt: (value: number) => string
	unit: string | undefined
	hovered: number | null
	insetLeft: number
	insetRight: number
}>

const translateFor = (anchor: "start" | "middle" | "end") =>
	anchor === "start" ? "translateX(0)" : anchor === "end" ? "translateX(-100%)" : "translateX(-50%)"

export const heatmapLegend = <M>(h: HtmlBuilder<M>, inputs: HeatmapLegendInputs): Html => {
	const { domain, span, scaleType } = inputs
	const ticks: ReadonlyArray<{ t: number; anchor: "start" | "middle" | "end" }> =
		span <= 0
			? [{ t: 0, anchor: "start" }]
			: [
					{ t: 0, anchor: "start" },
					{ t: 0.5, anchor: "middle" },
					{ t: 1, anchor: "end" },
				]
	return h.div(
		[
			h.DataAttribute("heatmap-legend", ""),
			h.Class("pt-2"),
			h.Style({
				height: `${LEGEND_BLOCK_H}px`,
				"padding-left": `${inputs.insetLeft}px`,
				"padding-right": `${inputs.insetRight}px`,
			}),
		],
		[
			h.div(
				[h.Class("relative flex gap-px"), h.Style({ height: `${LEGEND_BAR_H}px` })],
				[
					...Array.from({ length: LEGEND_STEPS }, (_, index) =>
						h.div([
							h.Class("flex-1 rounded-xs"),
							h.Style({
								"background-color": inputs.colorAt(
									valueAtRampPosition((index + 0.5) / LEGEND_STEPS, domain, scaleType),
								),
							}),
						]),
					),
					...(inputs.hovered === null
						? []
						: [
								h.div([
									h.AriaHidden(true),
									h.Class("pointer-events-none absolute"),
									h.Style({
										left: `${rampPositionOf(inputs.hovered, domain, scaleType) * 100}%`,
										top: "-1px",
										width: "1px",
										height: `${LEGEND_BAR_H + 2}px`,
										background: "var(--foreground)",
									}),
								]),
							]),
				],
			),
			h.div(
				[h.Class("relative mt-1.5"), h.Style({ height: "12px" })],
				ticks.map(({ t, anchor }) =>
					h.div(
						[
							h.Class("absolute tabular-nums text-muted-foreground"),
							h.Style({
								left: `${t * 100}%`,
								transform: translateFor(anchor),
								"font-size": `${LEGEND_FONT_PX}px`,
								"line-height": "1",
							}),
						],
						[
							formatScalar(
								roundTick(valueAtRampPosition(t, domain, scaleType), domain[0], span),
								inputs.unit,
							),
						],
					),
				),
			),
		],
	)
}
