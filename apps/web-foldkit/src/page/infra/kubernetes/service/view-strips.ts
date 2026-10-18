import { formatValueWithUnit } from "@maple/web/components/infra/chart-units"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../../../charts/chart"
import type { ThemeColors } from "../../../../charts/theme-colors"
import { panelStyles, panelToneStyles } from "@maple/ui/styles/ui/panel"
import { LINKED_CURSOR_STYLE, MountLinkedCursor } from "../../../../charts/linked-cursor"
import { type InfraRow, type InfraSeriesInfo, view as metricChartView } from "../../kit/metric-chart"
import { seriesLegend } from "../../../kit/series-legend"
import { Message } from "./message"
import type { Model } from "./model"

// `CorrelationStrips` (components/infra/service-lens/correlation-strips.tsx): three series on one time
// axis under one hover cursor.

const STRIP_HEIGHT = 96

export type StripSeries = Readonly<{
	id: string
	label: string
	source: string
	rows: ReadonlyArray<InfraRow>
	unit: string
	showThreshold?: boolean
}>

/** `LastValue`: the strip's trailing value; one series needs no key. */
const lastValue = (h: HtmlBuilder<Chart.Message>, info: InfraSeriesInfo): Html => {
	const summary = info.series.flatMap((name) => {
		const value = info.lastValues[name]
		return value === undefined ? [] : [{ name, value }]
	})
	if (summary.length === 0) return null
	const isKeyed = summary.length > 1
	return seriesLegend(h, {
		className: "mb-1",
		items: summary.map(({ name, value }) => ({
			key: name,
			label: isKeyed ? info.labelFor(name) : undefined,
			color: isKeyed ? info.colors.get(name) : undefined,
			value: formatValueWithUnit(value, info.unit),
		})),
	})
}

export const correlationStrips = (
	h: HtmlBuilder<Message>,
	model: Model,
	options: Readonly<{
		series: ReadonlyArray<StripSeries>
		xDomain: ReadonlyArray<string>
		isWaiting: boolean
		theme: ThemeColors
		timeZone: string
	}>,
): Html =>
	h.section(
		[
			h.Class(cn(panelStyles, panelToneStyles.default, cn("block", refreshingClass(options.isWaiting)))),
			h.DataAttribute("slot", "panel"),
			...(options.isWaiting ? [h.AriaBusy(true)] : []),
			h.Style(LINKED_CURSOR_STYLE),
			h.OnMount(MountLinkedCursor()),
		],
		options.series.map((strip, index) =>
			h.div(
				[h.Key(strip.id), h.Class(cn("flex items-center gap-4 px-4 py-3", index > 0 && "border-t"))],
				[
					h.div(
						[h.Class("flex w-[140px] shrink-0 flex-col gap-0.5")],
						[
							h.span([h.Class("text-xs font-medium text-foreground")], [strip.label]),
							h.span([h.Class("font-mono text-3xs text-muted-foreground")], [strip.source]),
						],
					),
					h.div(
						[h.Class("min-w-0 flex-1")],
						[
							h.submodel({
								slotId: `lens-strip-${strip.id}`,
								model: model.charts[strip.id] ?? Chart.init(),
								view: metricChartView,
								toParentMessage: (message: Chart.Message) => Message.GotChartMessage({ id: strip.id, message }),
								viewInputs: {
									chartId: `lens-${strip.id}`,
									rows: strip.rows,
									unit: strip.unit,
									seriesLabel: strip.label,
									showThreshold: strip.showThreshold,
									height: STRIP_HEIGHT,
									xDomain: options.xDomain,
									linkedChartId: `lens-${strip.id}`,
									isWaiting: options.isWaiting,
									header: lastValue,
									theme: options.theme,
									timeZone: options.timeZone,
								},
							}),
						],
					),
				],
			),
		),
	)
