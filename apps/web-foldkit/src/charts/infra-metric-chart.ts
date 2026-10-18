import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { chartEmpty } from "../ui/chart-skeleton"
import { bucketTooltipBody } from "./bucket-tooltip"
import type { Message, Model } from "./chart"
import type { ChartSpec } from "./chart-spec"
import type { ChartEventMarker } from "./event-marker-spec"
import { hasPlottableValue } from "./infra-metric-series"
import { plotFrame } from "./plot-frame"
import { resolveColor, type ThemeColors } from "./theme-colors"
import { type ChartUnit, type LongRow, seriesColorTokens, transformRows } from "./infra-metric-series"

// `InfraMetricChart` (apps/web/src/components/infra/primitives/infra-metric-chart.tsx): the wrapper,
// the linked-cursor marker and overlay, and the `CursorPlot` box. Embed with `h.submodel`.

export const INFRA_METRIC_CHART_HEIGHT = 220
export const CHART_EMPTY_MESSAGE = "No data for this metric in the selected window."

export type InfraMetricSpec = Extract<ChartSpec, { readonly _tag: "InfraMetric" }>

export type InfraMetricOptions = Readonly<{
	rows: ReadonlyArray<LongRow>
	unit: ChartUnit
	seriesLabel?: string
	stacked?: boolean
	showThreshold?: boolean
	xDomain?: ReadonlyArray<string>
	gaps?: boolean
	/** Fixed colours for series the name hash cannot see. */
	seriesColors?: Readonly<Record<string, string>>
	theme: ThemeColors
	timeZone: string
	gradientPrefix: string
	/** Deploys, drawn on every strip at the same instant. */
	markers?: ReadonlyArray<ChartEventMarker>
}>

/** The spec the Mount builds the definition from: rows plus every colour resolved to a literal. */
export const infraMetricSpec = (options: InfraMetricOptions): InfraMetricSpec => {
	const { series } = transformRows(options.rows)
	const tokens = seriesColorTokens(series)
	const border = resolveColor(options.theme, "--border")
	const colors = Object.fromEntries([
		...series.map((name) => {
			const token = options.seriesColors?.[name] ?? tokens.get(name) ?? "--border"
			return [name, resolveColor(options.theme, token)] as const
		}),
		["border", border],
		["background", resolveColor(options.theme, "--background")],
		// Legacy asks for `--severity-warn`, which `canvasSafeThresholdColor` rejects (a bare token is
		// not a CSS colour), so the rule paints in its `--destructive` fallback.
		["threshold", resolveColor(options.theme, "--destructive")],
	])
	return {
		_tag: "InfraMetric",
		rows: options.rows,
		unit: options.unit,
		seriesLabel: options.seriesLabel ?? null,
		stacked: options.stacked ?? false,
		showThreshold: options.showThreshold ?? false,
		xDomain: options.xDomain ?? null,
		gaps: options.gaps ?? false,
		colors,
		timeZone: options.timeZone,
		gradientPrefix: options.gradientPrefix,
		markers: options.markers ?? [],
		markerColors: {
			neutral: resolveColor(options.theme, "--muted-foreground"),
			warn: resolveColor(options.theme, "--severity-warn"),
			crit: resolveColor(options.theme, "--severity-error"),
			label: resolveColor(options.theme, "--muted-foreground"),
		},
	}
}

export interface InfraMetricChartInputs {
	readonly chartId: string
	readonly spec: InfraMetricSpec
	readonly linkedChartId?: string
	readonly isWaiting?: boolean
	readonly height?: number
	readonly className?: string
	/** The last-value strip above the plot (`header`). */
	readonly header?: Html
}

/** `LinkedCursorOverlay`: positioned by the page's linked-cursor Mount, when it has one. */
export const linkedCursorOverlay = <M>(h: HtmlBuilder<M>, id: string): Html =>
	h.div(
		[
			h.AriaHidden(true),
			h.Class("pointer-events-none absolute"),
			h.DataAttribute("linked-cursor-overlay", id),
			h.Style({ "container-type": "inline-size", opacity: "var(--linked-cursor-visible)" }),
		],
		[
			h.div([
				h.Class("absolute inset-y-0 left-0 w-px bg-muted-foreground/45 will-change-transform"),
				h.Style({ transform: "translateX(calc(var(--linked-cursor-ratio) * (100cqw - 1px)))" }),
			]),
		],
	)

export const view = Submodel.defineView<Model, Message, InfraMetricChartInputs>((model, inputs, h) => {
	const height = inputs.height ?? INFRA_METRIC_CHART_HEIGHT
	if (!hasPlottableValue(inputs.spec.rows)) {
		return chartEmpty(h, { height: inputs.height }, CHART_EMPTY_MESSAGE)
	}
	const isWaiting = inputs.isWaiting === true
	const linked = inputs.linkedChartId
	return h.div(
		[h.Class(cn(refreshingClass(isWaiting), inputs.className)), ...(isWaiting ? [h.AriaBusy(true)] : [])],
		[
			...(inputs.header === undefined ? [] : [inputs.header]),
			h.div(
				[
					h.Class("relative"),
					...(linked === undefined ? [] : [h.DataAttribute("linked-cursor-chart", linked)]),
				],
				[
					...(linked === undefined ? [] : [linkedCursorOverlay(h, linked)]),
					h.div(
						[h.Class("w-full"), h.Style({ height: `${height}px` })],
						[
							plotFrame(h, {
								chartId: inputs.chartId,
								spec: inputs.spec,
								ariaLabel: inputs.spec.seriesLabel ?? "Utilization",
								className: "h-full w-full",
								tooltipBody: (portal) =>
									Option.flatMap(model.tooltip, (tooltip) =>
										tooltip._tag === "Bucket"
											? Option.some(bucketTooltipBody(h, tooltip, portal))
											: Option.none(),
									),
							}),
						],
					),
				],
			),
		],
	)
})
