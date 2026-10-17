import { refreshingClass } from "@maple/ui/lib/refreshing"
import { SEVERITY_COLORS } from "@maple/ui/lib/severity"
import { formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../../charts/chart"
import type { ChartSpec } from "../../../charts/chart-spec"
import { plotFrame } from "../../../charts/plot-frame"
import { resolveColor, type ThemeColors } from "../../../charts/theme-colors"
import { volumeSeriesKeys, volumeTotal } from "./derive"
import { Message } from "./message"
import type { Model, VolumeBucket } from "./model"

// `LogsVolumeChart` (apps/web/src/components/logs/logs-volume-chart.tsx).

/** The strip is a scrubber above the list, not a chart in its own right. */
export const LOGS_VOLUME_CHART_HEIGHT = 120

const FALLBACK_SEVERITY_TOKEN = "var(--color-muted-foreground)"

/** The custom properties the plot reads: every severity colour plus the chrome border. */
export const VOLUME_THEME_TOKENS = [
	...new Set([...Object.values(SEVERITY_COLORS), FALLBACK_SEVERITY_TOKEN, "--border"]),
]

const severityToken = (key: string) => SEVERITY_COLORS[key.toUpperCase()] ?? FALLBACK_SEVERITY_TOKEN

const volumeSpec = (
	buckets: ReadonlyArray<VolumeBucket>,
	theme: ThemeColors,
	timeZone: string,
): ChartSpec => {
	const seriesKeys = volumeSeriesKeys(buckets)
	return {
		_tag: "LogsVolume",
		buckets,
		seriesKeys,
		colors: Object.fromEntries(seriesKeys.map((key) => [key, resolveColor(theme, severityToken(key))])),
		border: resolveColor(theme, "--border"),
		selection: null,
		isSelecting: false,
		timeZone,
	}
}

type PlotInputs = Readonly<{ spec: ChartSpec }>

/** `CursorPlot` with `ariaLabel="Log volume by severity"` in its 120px strip. */
const volumePlot = Submodel.defineView<Chart.Model, Chart.Message, PlotInputs>((_model, inputs, h) =>
	plotFrame(h, {
		chartId: "logs-volume",
		spec: inputs.spec,
		ariaLabel: "Log volume by severity",
		className: "h-full w-full",
		// TODO(volume-tooltip): `PlotTooltipBody` for the hovered bucket.
		tooltipBody: () => Option.none(),
	}),
)

const header = (h: HtmlBuilder<Message>, total: number): Html =>
	h.div(
		[h.Class("mb-1 flex items-baseline gap-2")],
		[
			h.span([h.Class("text-sm font-medium")], [formatNumber(total), " logs"]),
			h.span([h.Class("text-xs text-muted-foreground")], ["in selected range"]),
		],
	)

export const volumeChart = (h: HtmlBuilder<Message>, model: Model, timeZone: string): Html =>
	AsyncData.matchData(model.volume.data, {
		// TODO(volume-loading): `ChartLoading variant="bar"`.
		onEmpty: () => h.div([h.Style({ height: `${LOGS_VOLUME_CHART_HEIGHT}px` })], []),
		// Legacy renders nothing for a failed volume query.
		onFailure: () => h.empty,
		onData: (buckets) => {
			const isWaiting = AsyncData.isRefreshing(model.volume.data)
			const total = volumeTotal(buckets)
			return h.div(
				[h.Class(refreshingClass(isWaiting)), ...(isWaiting ? [h.AriaBusy(true)] : [])],
				[
					header(h, total),
					total === 0 || model.themeColors === null
						? h.div([h.Style({ height: `${LOGS_VOLUME_CHART_HEIGHT}px` })], [])
						: h.div(
								[
									h.Style({ height: `${LOGS_VOLUME_CHART_HEIGHT}px` }),
									h.Class(cn("w-full select-none", "cursor-crosshair")),
								],
								[
									h.submodel({
										slotId: "logs-volume-plot",
										model: model.volumeChart,
										view: volumePlot,
										viewInputs: {
											spec: volumeSpec(buckets, model.themeColors, timeZone),
										},
										toParentMessage: (message) =>
											Message.GotVolumeChartMessage({ message }),
									}),
								],
							),
				],
			)
		},
	})
