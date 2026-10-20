import { countLabel } from "@maple/ui/lib/format"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../../../charts/chart"
import { panel, panelHeader } from "../../../../ui/panel"
import { middleTruncate } from "../../../../ui/middle-truncate"
import { formatValueWithUnit } from "../../../../components/infra/chart-units"
import { LINKED_CURSOR_STYLE, MountLinkedCursor } from "../../../../charts/linked-cursor"
import { INFRA_METRIC_CHART_HEIGHT, type InfraSeriesInfo, metricView as metricChartView } from "../../../../charts/infra-metric-chart"
import { chartError, chartLoading, chartPlotArea } from "../../../../ui/chart-state"
import { attributeSection, metaRow, resourceAttributesCard } from "../../kit/resource-attributes"
import { seriesLegend } from "../../../kit/series-legend"
import { formatSeen } from "../../../metrics/time-format"
import { type HostMetric, Message } from "./message"
import type { HostSummary, Model } from "./model"

// `HostMetadataPanel`, and the Metrics panel of `HostDetailPage` with its `MetricStrip`s.

type H = HtmlBuilder<Message>

export const hostMetadataPanel = (h: H, model: Model, summary: NonNullable<HostSummary>, nowMs: number, timeZone: string): Html => {
	const row = (label: string, value: string, extra: Readonly<{ copyable?: boolean; copyValue?: string; tooltip?: string }>) =>
		metaRow(h, {
			label,
			value,
			...extra,
			copies: model.copies,
			onCopy: (l, message) => Message.GotCopyMessage({ label: l, message }),
		})
	return resourceAttributesCard(
		h,
		"ServerIcon",
		[
			attributeSection(h, "Identity", [row("host.name", summary.hostName, { copyable: true })]),
			attributeSection(h, "Platform", [
				row("os.type", summary.osType, { copyable: true }),
				row("host.arch", summary.hostArch, { copyable: true }),
			]),
			attributeSection(h, "Cloud", [
				row("cloud.provider", summary.cloudProvider, { copyable: true }),
				row("cloud.region", summary.cloudRegion, { copyable: true }),
			]),
			attributeSection(h, "Lifecycle", [
				row("first seen", formatRelativeTime(summary.firstSeen, nowMs), {
					copyValue: summary.firstSeen,
					tooltip: formatSeen(summary.firstSeen, timeZone),
				}),
				row("last seen", formatRelativeTime(summary.lastSeen, nowMs), {
					copyValue: summary.lastSeen,
					tooltip: formatSeen(summary.lastSeen, timeZone),
				}),
			]),
		],
		"divide-y divide-border/60",
	)
}

export const METRIC_STRIPS: ReadonlyArray<Readonly<{ metric: HostMetric; label: string; caption: string }>> = [
	{ metric: "cpu", label: "CPU", caption: "Per-mode utilization · stacked area" },
	{ metric: "memory", label: "Memory", caption: "Used / cached / free · stacked" },
	{ metric: "filesystem", label: "Filesystem", caption: "Mountpoint utilization" },
	{ metric: "network", label: "Network", caption: "Throughput in/out per device" },
	{ metric: "load15", label: "Load 15m", caption: "Linux load average" },
]

const SERIES_LABELS = new Map<HostMetric, string>([
	["cpu", "CPU"],
	["memory", "Memory"],
	["filesystem", "Disk"],
	["network", "Network"],
	["load15", "Load (15m)"],
])

const stripChart = (h: H, model: Model, metric: HostMetric, timeZone: string): Html => {
	const slot = model.series[metric]
	const data = slot === undefined ? AsyncData.Idle() : slot.data
	const theme = model.themeColors
	return AsyncData.matchData(data, {
		onEmpty: () => chartLoading(h, { variant: "area" }),
		onFailure: (failure) => chartError(h, {}, [failure.message]),
		onData: (series) =>
			theme === null || model.chartRuntime._tag === "Loading"
				? chartLoading(h, { variant: "area" })
				: h.submodel({
						slotId: `host-chart-${metric}`,
						model: model.charts[metric] ?? Chart.init(),
						view: metricChartView,
						toParentMessage: (message: Chart.Message) => Message.GotChartMessage({ metric, message }),
						viewInputs: {
							chartId: `host-${metric}`,
							rows: series.rows,
							unit: series.unit,
							seriesLabel: SERIES_LABELS.get(metric),
							stacked: metric === "cpu" || metric === "memory",
							showThreshold: metric === "cpu" || metric === "memory",
							linkedChartId: `host-${metric}`,
							header: hostSeriesSummary,
							isWaiting: AsyncData.isRefreshing(data),
							plotAreaHeight: INFRA_METRIC_CHART_HEIGHT,
							theme,
							timeZone,
						},
					}),
	})
}

/** `MetricStrip`. */
const metricStrip = (h: H, model: Model, strip: (typeof METRIC_STRIPS)[number], timeZone: string): Html =>
	h.section(
		[h.Key(strip.metric), h.Class("grid grid-cols-1 gap-0 border-t first:border-t-0 lg:grid-cols-[160px_1fr]")],
		[
			h.div(
				[h.Class("border-b px-1 py-3 lg:border-b-0 lg:border-r lg:py-5")],
				[
					h.div([h.Class("text-xs font-medium text-foreground")], [strip.label]),
					h.div([h.Class("mt-1 text-2xs leading-relaxed text-muted-foreground")], [strip.caption]),
				],
			),
			h.div([h.Class("lg:pl-4")], [chartPlotArea(h, INFRA_METRIC_CHART_HEIGHT, [stripChart(h, model, strip.metric, timeZone)])]),
		],
	)

/** The Metrics panel: one strip per host metric, under one linked hover cursor. */
export const metricsPanel = (h: H, model: Model, timeZone: string): Html =>
	panel(h, { className: "overflow-visible" }, [
		panelHeader(h, {
			title: "Metrics",
			action: h.span([h.Class("text-xs tabular-nums text-muted-foreground")], [countLabel(METRIC_STRIPS.length, "signal")]),
		}),
		h.div(
			[h.Class("px-4"), h.Style(LINKED_CURSOR_STYLE), h.OnMount(MountLinkedCursor())],
			METRIC_STRIPS.map((strip) => metricStrip(h, model, strip, timeZone)),
		),
	])

/** `HostSeriesSummary`: the right-aligned last-value strip. */
export const hostSeriesSummary = (h: HtmlBuilder<Chart.Message>, info: InfraSeriesInfo): Html =>
	seriesLegend(h, {
		className: "px-3 py-2",
		maxItems: 8,
		items: info.series.map((name) => {
			const value = info.lastValues[name]
			const label = info.labelFor(name)
			return {
				key: name,
				label: middleTruncate(h, { text: label, tail: 10 }),
				title: label,
				color: info.colors.get(name),
				value: value === undefined ? undefined : formatValueWithUnit(value, info.unit),
			}
		}),
	})
