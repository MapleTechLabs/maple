import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import type { Message, Model } from "../../charts/chart"
import { ChartSpec, ChartTooltip } from "../../charts/chart-spec"
import { type BucketTooltip, bucketTooltipBody } from "../../charts/bucket-tooltip"
import { plotFrame } from "../../charts/plot-frame"
import { legendRow, type PlotLegendSeries } from "../../charts/plot-legend"
import { sequentialColorScale } from "../../charts/sequential-colors"
import { resolveColor, type ThemeColors } from "../../charts/theme-colors"
import { formatNumber } from "@maple/ui/lib/format"
import { HEATMAP_SPIKE_ROWS, heatmapSpikeModel } from "./spike-heatmap-model"
import { RAMP_TOKENS, type TokenWithFallback } from "./spike-timeseries-tokens"

// A `/lab/charts` prototype in its `PlotFrame`: the lab host draws it from `ChartSpec.LabSpike`,
// the frame carries its DOM legend (`PlotSeriesLegend`) and the tooltip body.

export interface SpikeInputs {
	readonly chartId: string
	readonly arm: string
	readonly theme: ThemeColors
	/** The tokens the arm's definition reads, resolved here (canvas cannot read `var()`). */
	readonly tokens: ReadonlyArray<string | TokenWithFallback>
	readonly footer?: string
	readonly ariaLabel: string
	readonly className?: string
	/** `PlotSeriesLegend`: pinned emphasis by click, nothing on hover. */
	readonly legend?: Readonly<{ label: string; series: ReadonlyArray<PlotLegendSeries> }>
}

type H = HtmlBuilder<Message>

const swatch = (h: H, color: string, isDashed: boolean): Html =>
	h.span([
		h.Class(
			isDashed ? "size-2.5 shrink-0 rounded-xs border border-dashed" : "size-2.5 shrink-0 rounded-xs",
		),
		h.Style(isDashed ? { "border-color": color } : { "background-color": color }),
	])

const figure = (h: H, value: string): Html =>
	h.span([h.Class("font-mono font-semibold text-foreground tabular-nums")], [value])

/** The stacked bar's body: the bucket, one row per service (the hovered one bold), the total. */
const stackTooltipBody = (h: H, bucket: BucketTooltip, total: string, portal: Attribute<Message>): Html =>
	h.div(
		[h.Class("grid min-w-[9rem] items-start gap-1.5"), portal],
		[
			h.div(
				[h.Class("border-border-subtle border-b pb-1 font-medium text-muted-foreground tracking-tight")],
				[bucket.heading],
			),
			h.div(
				[h.Class("grid gap-1.5")],
				bucket.rows.map((row) =>
					h.div(
						[
							h.Key(row.label),
							h.Class(
								row.label === bucket.highlighted
									? "flex w-full items-center gap-2 [&_*]:font-semibold"
									: "flex w-full items-center gap-2",
							),
						],
						[
							swatch(h, row.color, row.dashed),
							h.div(
								[h.Class("flex flex-1 items-center justify-between gap-3 leading-none")],
								[
									h.span([h.Class("text-muted-foreground")], [row.label]),
									figure(h, row.value),
								],
							),
						],
					),
				),
			),
			h.div(
				[
					h.Class(
						"flex w-full items-center justify-between gap-3 border-border-subtle border-t pt-1 leading-none",
					),
				],
				[h.span([h.Class("text-muted-foreground")], ["Total"]), figure(h, total)],
			),
		],
	)

/** The scene-legend arm's body: the hovered band alone. */
const bandTooltipBody = (h: H, bucket: BucketTooltip, portal: Attribute<Message>): Html =>
	h.div(
		[h.Class("flex items-center gap-2"), portal],
		bucket.rows.flatMap((row) => [
			swatch(h, row.color, false),
			h.span([h.Class("text-muted-foreground")], [row.label]),
			figure(h, row.value),
		]),
	)

/** `HeatmapSpike`'s body: the cell's coordinates, its swatch and count, or "no data" on a hole. */
const slotTooltipBody = (
	h: H,
	slot: Extract<ChartTooltip, { readonly _tag: "HeatmapSlot" }>,
	inputs: SpikeInputs,
	portal: Attribute<Message>,
): Html => {
	const label = h.span([h.Class("text-muted-foreground")], [`${slot.x} · ${slot.y}`])
	if (slot.value === null)
		return h.div(
			[h.Class("flex items-center gap-2"), portal],
			[label, h.span([h.Class("text-muted-foreground italic")], ["no data"])],
		)
	const model = heatmapSpikeModel(HEATMAP_SPIKE_ROWS)
	const colorAt = sequentialColorScale({
		stops: RAMP_TOKENS.amber.map(([token, fallback]) => resolveColor(inputs.theme, token, fallback)),
		domain: model.domain,
		scaleType: "linear",
	})
	return h.div(
		[h.Class("flex items-center gap-2"), portal],
		[
			h.span([
				h.Class("size-2.5 shrink-0 rounded-xs"),
				h.Style({ "background-color": colorAt(slot.value) }),
			]),
			label,
			h.span([h.Class("font-mono font-semibold tabular-nums")], [formatNumber(slot.value)]),
		],
	)
}

const muted = (h: H, text: string): Html => h.span([h.Class("text-muted-foreground")], [text])
const mono = (h: H, text: string): Html => h.span([h.Class("font-mono font-semibold tabular-nums")], [text])
const keyValue = (h: H, label: string, value: string, className: string): Html =>
	h.div([h.Class(className)], [muted(h, label), mono(h, value)])

/** `BoxPlotSpike`'s body: the operation, then its outlier or its five-number summary. */
const boxTooltipBody = (h: H, bucket: BucketTooltip, portal: Attribute<Message>): Html => {
	const heading = h.div(
		[h.Class("border-border-subtle border-b pb-1 font-medium text-muted-foreground tracking-tight")],
		[bucket.heading],
	)
	const row = (label: string, value: string, className: string) =>
		h.div([h.Key(label), h.Class(className)], [muted(h, label), figure(h, value)])
	const base = "flex w-full items-center justify-between gap-3 leading-none"
	if (bucket.highlighted === undefined)
		return h.div(
			[h.Class("grid min-w-[10rem] items-start gap-1.5"), portal],
			[heading, ...bucket.rows.map((entry) => row(entry.label, entry.value, base))],
		)
	return h.div(
		[h.Class("grid min-w-[11rem] items-start gap-1.5"), portal],
		[
			heading,
			h.div(
				[h.Class("grid gap-1.5")],
				bucket.rows.map((entry) =>
					row(
						entry.label,
						entry.value,
						entry.label === bucket.highlighted ? `${base} [&_*]:font-semibold` : base,
					),
				),
			),
		],
	)
}

/** The body each arm's `renderTooltipBody` draws, from the heading and rows its host packed. */
const bucketBody = (h: H, arm: string, bucket: BucketTooltip, portal: Attribute<Message>): Html => {
	const [first, second] = bucket.rows
	switch (arm) {
		case "box-plot":
			return boxTooltipBody(h, bucket, portal)
		case "trace-scatter":
			return h.div(
				[h.Class("flex flex-col gap-0.5"), portal],
				[
					h.div(
						[h.Class("flex items-center gap-2")],
						[swatch(h, first?.color ?? "", false), mono(h, first?.label ?? "")],
					),
					muted(h, first?.value ?? ""),
					muted(h, bucket.heading),
				],
			)
		case "sankey":
		case "sankey-legend":
			return bucket.heading === ""
				? h.div(
						[h.Class("flex items-center gap-2"), portal],
						[
							swatch(h, first?.color ?? "", false),
							muted(h, first?.label ?? ""),
							mono(h, first?.value ?? ""),
						],
					)
				: h.div(
						[h.Class("flex flex-col gap-1"), portal],
						[
							h.div(
								[h.Class("flex items-center gap-2")],
								[swatch(h, first?.color ?? "", false), muted(h, bucket.heading)],
							),
							keyValue(
								h,
								first?.label ?? "",
								first?.value ?? "",
								"flex items-center justify-between gap-4 pl-[18px]",
							),
							keyValue(
								h,
								second?.label ?? "",
								second?.value ?? "",
								"flex items-center justify-between gap-4 pl-[18px]",
							),
						],
					)
		case "treemap":
		case "treemap-legend":
			return h.div(
				[h.Class("flex flex-col gap-1"), portal],
				[
					h.div(
						[h.Class("flex items-center gap-2")],
						[
							swatch(h, first?.color ?? "", false),
							muted(h, bucket.heading),
							h.span([h.Class("font-medium")], [first?.label ?? ""]),
						],
					),
					keyValue(
						h,
						"spans",
						first?.value ?? "",
						"flex items-center justify-between gap-4 pl-[18px]",
					),
				],
			)
		default:
			return bucket.total !== undefined
				? stackTooltipBody(h, bucket, bucket.total, portal)
				: bucket.heading === ""
					? bandTooltipBody(h, bucket, portal)
					: bucketTooltipBody(h, bucket, portal)
	}
}

export const spikeView = Submodel.defineView<Model, Message, SpikeInputs>((model, inputs, h): Html => {
	const legend = inputs.legend
	return plotFrame(h, {
		chartId: inputs.chartId,
		className: inputs.className,
		ariaLabel: inputs.ariaLabel,
		host: "lab",
		spec: ChartSpec.LabSpike({
			arm: inputs.arm,
			colors: Object.fromEntries(
				inputs.tokens.map((token) =>
					typeof token === "string"
						? [token, resolveColor(inputs.theme, token)]
						: [token[0], resolveColor(inputs.theme, token[0], token[1])],
				),
			),
			highlighted: legend === undefined ? null : Option.getOrNull(model.highlightedKey),
			active: null,
			hidden: model.hiddenKeys,
		}),
		...(inputs.footer === undefined
			? undefined
			: {
					footer: h.p(
						[h.Class("pt-1 text-right text-3xs text-foreground-subtle")],
						[inputs.footer],
					),
				}),
		legend:
			legend === undefined
				? undefined
				: legendRow(h, {
						series: legend.series,
						highlighted: model.highlightedKey,
						active: Option.none(),
						label: legend.label,
					}),
		tooltipBody: (portal) =>
			Option.flatMap(model.tooltip, (tooltip) =>
				ChartTooltip.match(tooltip, {
					Bucket: (bucket) => Option.some(bucketBody(h, inputs.arm, bucket, portal)),
					PieSlice: () => Option.none(),
					NumericBin: () => Option.none(),
					CategoricalBin: () => Option.none(),
					HeatmapSlot: (slot) => Option.some(slotTooltipBody(h, slot, inputs, portal)),
				}),
			),
	})
})
