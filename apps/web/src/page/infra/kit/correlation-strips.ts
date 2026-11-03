import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import type { ChartEventMarker } from "@maple/views/charts/event-marker-spec"
import * as InfraMetricChart from "@maple/views/charts/infra-metric-chart"
import {
	type ChartUnit,
	formatValueWithUnit,
	type LongRow,
	transformRows,
	UNNAMED_SERIES_KEY,
} from "@maple/views/charts/infra-metric-series"
import type { ThemeColors } from "@maple/views/charts/theme-colors"
import { LINKED_CURSOR_STYLE } from "@maple/views/charts/linked-cursor"
import { panel } from "@maple/views/ui/panel"
import { seriesLegend } from "../../kit/series-legend"
import { typography } from "@maple/views/ui/typography"
import { hstackClass, vstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"

// `CorrelationStrips`: signals stacked on one time axis under one linked cursor, each with its label, source
// and window summary.

const STRIP_HEIGHT = 96

export type StripSeries = Readonly<{
	id: string
	label: string
	source: string
	rows: ReadonlyArray<LongRow>
	unit: ChartUnit
	showThreshold?: boolean
	stacked?: boolean
	/** The window summary under the label; without one the plot gets a last-value legend. */
	summary?: ReadonlyArray<Html>
	/** Fixed series colours (tokens), for names the identity hash can't see. */
	colors?: Readonly<Record<string, string>>
}>

export type CorrelationStripsOptions<M> = Readonly<{
	strips: ReadonlyArray<StripSeries>
	xDomain: ReadonlyArray<string>
	markers?: ReadonlyArray<ChartEventMarker>
	isWaiting?: boolean
	theme: ThemeColors
	timeZone: string
	/** The page's linked-cursor Mount. */
	mountCursor: Attribute<M>
	/** Embeds one strip's chart (`h.submodel` with the page's chart Message). */
	chart: (chartId: string, inputs: Omit<InfraMetricChart.InfraMetricChartInputs, "chartId">) => Html
}>

/** `LastValue`: the latest bucket's value per series, keyed only when there are several. */
const lastValue = <M>(
	h: HtmlBuilder<M>,
	strip: StripSeries,
	spec: InfraMetricChart.InfraMetricSpec,
): Html | undefined => {
	const { data, series } = transformRows(strip.rows)
	const latest = data[data.length - 1]
	if (latest === undefined) return undefined
	const summary = Arr.flatMap(series, (name) => {
		const value = latest[name]
		return typeof value === "number" ? [{ name, value }] : []
	})
	if (summary.length === 0) return undefined
	const keyed = summary.length > 1
	return seriesLegend(h, {
		className: "mb-1",
		items: Arr.map(summary, ({ name, value }) => ({
			key: name,
			label: keyed ? (name === UNNAMED_SERIES_KEY ? strip.label : name) : undefined,
			color: keyed ? spec.colors[name] : undefined,
			value: formatValueWithUnit(value, strip.unit),
		})),
	})
}

export const correlationStrips = <M>(h: HtmlBuilder<M>, options: CorrelationStripsOptions<M>): Html => {
	const isWaiting = options.isWaiting === true
	return panel(
		h,
		{
			className: cn("block", refreshingClass(isWaiting)),
			attributes: [
				...(isWaiting ? [h.AriaBusy(true)] : []),
				h.Style(LINKED_CURSOR_STYLE),
				options.mountCursor,
			],
		},
		Arr.map(options.strips, (strip, index) => {
			const spec = InfraMetricChart.infraMetricSpec({
				rows: strip.rows,
				unit: strip.unit,
				seriesLabel: strip.label,
				stacked: strip.stacked,
				showThreshold: strip.showThreshold,
				xDomain: options.xDomain,
				seriesColors: strip.colors,
				theme: options.theme,
				timeZone: options.timeZone,
				gradientPrefix: `strip-${strip.id}`,
				markers: options.markers,
			})
			return h.div(
				[
					h.Key(strip.id),
					h.Class(cn(hstackClass({ gap: "4", className: "px-4 py-3" }), index > 0 && "border-t")),
				],
				[
					vstack(h, { gap: "0.5", className: "w-36 shrink-0" }, [
						typography(h, { size: "xs", tone: "foreground", weight: "medium" }, [strip.label]),
						typography(h, { size: "3xs", tone: "muted", mono: true }, [strip.source]),
						...(strip.summary === undefined
							? []
							: [h.div([h.Class("mt-2 flex flex-col gap-0.5")], strip.summary)]),
					]),
					h.div(
						[h.Class("min-w-0 flex-1")],
						[
							options.chart(`strip-${strip.id}`, {
								spec,
								linkedChartId: `lens-${strip.id}`,
								height: STRIP_HEIGHT,
								isWaiting,
								header: strip.summary === undefined ? lastValue(h, strip, spec) : undefined,
							}),
						],
					),
				],
			)
		}),
	)
}
