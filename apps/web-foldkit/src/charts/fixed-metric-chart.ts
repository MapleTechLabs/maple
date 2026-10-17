import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import type { Message, Model } from "./chart"
import { ChartTooltip, type ChartSpec } from "./chart-spec"
import { plotFrame } from "./plot-frame"

// The `PlotFrame` half of `ThroughputAreaChart`, `ErrorRateAreaChart` and `LatencyLineChart`, with
// `PlotTooltipBody` as the tooltip. Embed it with `h.submodel`; the definition is built in the Mount.
// TODO(tooltip-highlight): the series nearest the pointer is not emphasised (`resolveTooltipHighlight`).

export interface FixedMetricChartInputs {
	readonly chartId: string
	readonly ariaLabel: string
	readonly spec: Extract<ChartSpec, { readonly _tag: "FixedMetric" }>
	readonly className?: string
}

type Bucket = Extract<ChartTooltip, { readonly _tag: "Bucket" }>

/** `PlotTooltipBody`: the bucket heading, then one swatch, label and value per series. */
const bucketBody = (h: HtmlBuilder<Message>, tooltip: Bucket, portal: Attribute<Message>): Html =>
	h.div(
		[h.Class("grid min-w-[9rem] max-w-[22rem] items-start gap-1.5"), portal],
		[
			h.div(
				[h.Class("border-border/50 border-b pb-1 font-medium text-muted-foreground tracking-tight")],
				[tooltip.heading],
			),
			h.div(
				[h.Class("grid gap-1.5")],
				tooltip.rows.map((row, index) =>
					h.div(
						[h.Key(`${index}:${row.label}`), h.Class("flex w-full items-center gap-2")],
						[
							h.span([
								h.Class(
									row.dashed
										? "size-2.5 shrink-0 rounded-xs border border-dashed"
										: "size-2.5 shrink-0 rounded-xs",
								),
								h.Style(
									row.dashed
										? { "border-color": row.color }
										: { "background-color": row.color },
								),
							]),
							h.div(
								[h.Class("flex flex-1 items-center justify-between gap-3 leading-none")],
								[
									h.span(
										[
											h.Class("min-w-0 truncate text-muted-foreground"),
											h.Title(row.label),
										],
										[row.label],
									),
									h.span(
										[
											h.Class(
												"shrink-0 font-mono font-semibold text-foreground tabular-nums",
											),
										],
										[row.value],
									),
								],
							),
						],
					),
				),
			),
		],
	)

export const view = Submodel.defineView<Model, Message, FixedMetricChartInputs>((model, inputs, h) =>
	plotFrame(h, {
		chartId: inputs.chartId,
		spec: inputs.spec,
		ariaLabel: inputs.ariaLabel,
		className: inputs.className,
		tooltipBody: (portal) =>
			Option.flatMap(model.tooltip, (tooltip) =>
				tooltip._tag === "Bucket" ? Option.some(bucketBody(h, tooltip, portal)) : Option.none(),
			),
	}),
)
