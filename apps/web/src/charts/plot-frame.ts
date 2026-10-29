import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { ChartAttribute, ChartViewBuilder, Message } from "./chart"
import { CHART_LABEL_ATTRIBUTE, CHART_SPEC_ATTRIBUTE, type ChartSpec, encodeChartSpec } from "./chart-spec"
import { type ChartRenderer, MountChart, PLOT_BOX_ATTRIBUTE, PortalTooltipBody } from "./chart-mounts"
// The tooltip shell theming, imported here because every chart goes through the frame.
import "@maple/ui/components/plot/plot-tooltip.css"

// Port of `PlotFrame` (packages/ui/src/components/plot/plot-frame.tsx). The markup and class
// composition are the React component's; the chart itself is mounted by `MountChart`.

export interface PlotFrameInputs {
	readonly chartId: string
	readonly spec: ChartSpec
	readonly ariaLabel: string
	readonly renderer?: ChartRenderer
	readonly className?: string | undefined
	readonly legend?: Html | undefined
	readonly legendPlacement?: "bottom" | "right"
	readonly footer?: Html
	readonly overlay?: Html
	/** The chart reports its plot geometry (`Message.RenderedPlot`) so the page can draw `overlay`. */
	readonly reportPlot?: boolean
	/** The `/lab/charts` prototypes' host (`MountChart host`). */
	readonly host?: "lab"
	/**
	 * `renderTooltipBody(...)` for the current tooltip datum, `None` while the tooltip is hidden. The
	 * body's root carries `portal`, the Mount that moves it into the library's tooltip shell.
	 */
	readonly tooltipBody: (portal: ChartAttribute) => Option.Option<Html>
}

/** Renders the tooltip body out of layout; its portal Mount moves it into the tooltip shell. */
const tooltipHolder = (h: ChartViewBuilder, inputs: PlotFrameInputs): Html =>
	h.div(
		[h.Hidden(true), h.DataAttribute("chart-tooltip-holder", "")],
		Option.toArray(inputs.tooltipBody(h.OnMount(PortalTooltipBody()))),
	)

// NOTE: the plot box and the side-legend row are separate view functions so their identities differ;
// as inline same-tag divs they would patch into each other when the legend moves beside the plot.
const plotBox = (
	h: ChartViewBuilder,
	inputs: PlotFrameInputs,
	renderer: ChartRenderer,
	sideLegend: boolean,
): Html =>
	h.div(
		[
			h.Class(cn("relative min-h-0 flex-1", sideLegend && "min-w-0")),
			h.Attribute(PLOT_BOX_ATTRIBUTE, ""),
			h.Attribute(CHART_SPEC_ATTRIBUTE, encodeChartSpec(inputs.spec)),
			h.Attribute(CHART_LABEL_ATTRIBUTE, inputs.ariaLabel),
			h.OnMount(
				MountChart({
					chartId: inputs.chartId,
					ariaLabel: inputs.ariaLabel,
					renderer,
					reportPlot: inputs.reportPlot ?? false,
					...(inputs.host === undefined ? undefined : { host: inputs.host }),
				}),
			),
		],
		[
			h.div(
				[h.Class("ts-chart-host"), h.Style({ position: "relative", width: "100%" })],
				[h.div([h.Class("ts-chart-surface"), h.Style({ width: "100%", height: "100%" })])],
			),
			h.div([
				h.DataAttribute("chart-plot", ""),
				h.AriaHidden(true),
				h.Class("pointer-events-none absolute top-0 left-0"),
			]),
			...(inputs.overlay === undefined
				? []
				: [
						h.div(
							[
								h.DataAttribute("chart-overlay", ""),
								h.Class("pointer-events-none absolute inset-0"),
							],
							[inputs.overlay],
						),
					]),
			tooltipHolder(h, inputs),
		],
	)

const sideLegendRow = (h: HtmlBuilder<Message>, plot: Html, legend: Html): Html =>
	h.div(
		[h.DataAttribute("chart-legend-row", ""), h.Class("flex min-h-0 flex-1 flex-row gap-3")],
		[plot, h.div([h.Class("max-w-[45%] shrink-0 overflow-auto")], [legend])],
	)

export const plotFrame = (h: ChartViewBuilder, inputs: PlotFrameInputs): Html => {
	const renderer = inputs.renderer ?? "canvas"
	const legendPlacement = inputs.legendPlacement ?? "bottom"
	const sideLegend = legendPlacement === "right" && inputs.legend !== undefined
	const hostClassName = cn("flex flex-col select-none", inputs.className)
	const plot = plotBox(h, inputs, renderer, sideLegend)

	return h.div(
		[h.DataAttribute("chart-host", renderer), h.Class(hostClassName)],
		[
			sideLegend && inputs.legend !== undefined ? sideLegendRow(h, plot, inputs.legend) : plot,
			...(inputs.legend !== undefined && !sideLegend
				? [h.div([h.Class("max-h-[45%] shrink-0 overflow-auto")], [inputs.legend])]
				: []),
			...(inputs.footer === undefined ? [] : [h.div([h.Class("shrink-0")], [inputs.footer])]),
		],
	)
}
