import {
	gcpBuckets,
	gcpChartMetric,
	gcpClassRows,
	gcpLineRows,
	type GcpChart,
	type GcpChartWindow,
} from "../../../../components/infra/gcp/charts"
import {
	gcpStripDomain,
	gcpWorkloadStrips,
	type GcpStripSummary,
} from "../../../../components/infra/gcp/workload-signals"
import type { GcpInfraServiceId } from "@maple/domain/gcp-infra"
import { resolveSeriesColors } from "@maple/ui/lib/semantic-series-colors"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Chart from "../../../../charts/chart"
import * as InfraMetricChart from "../../../../charts/infra-metric-chart"
import type { ThemeColors } from "../../../../charts/theme-colors"
import { AppRoute, hrefOf } from "../../../../route"
import { icon } from "../../../../ui/icon"
import { panelStyles, panelToneStyles } from "@maple/ui/styles/ui/panel"
import { CHART_HEIGHT, chartCard, chartCardMessage } from "../../kit/chart-card"
import { LINKED_CURSOR_STYLE } from "../../../../charts/linked-cursor"
import { seriesLegend } from "../../../kit/series-legend"
import type { BucketPoint } from "../data"
import { MountLinkedCursor } from "./command"
import { Message, type Model } from "./model"

// `CorrelationStrips` as the workload's signals, and `GcpWorkloadCharts`.

type H = HtmlBuilder<Message>
type TimeSearch = Readonly<{ startTime?: string; endTime?: string; timePreset?: string }>

export type ChartsContext = Readonly<{ theme: ThemeColors; timeZone: string }>

const STRIP_HEIGHT = 96

const chart = (
	h: H,
	model: Model,
	chartId: string,
	inputs: Omit<InfraMetricChart.InfraMetricChartInputs, "chartId">,
): Html =>
	h.submodel({
		slotId: chartId,
		model: model.charts[chartId] ?? Chart.init(),
		view: InfraMetricChart.view,
		toParentMessage: (message: Chart.Message) => Message.GotChartMessage({ chartId, message }),
		viewInputs: { ...inputs, chartId },
	})

const summaryView = (h: H, summary: GcpStripSummary): ReadonlyArray<Html> => [
	h.span(
		[
			h.Class(
				cn(
					"font-mono text-sm font-semibold tabular-nums text-foreground",
					summary.alert === true && "text-severity-error",
				),
			),
		],
		[summary.value],
	),
	...(summary.caption === undefined
		? []
		: [h.span([h.Class("font-mono text-3xs text-muted-foreground")], [summary.caption])]),
]

/** The signals that explain each other, on one time axis under one cursor. */
export const correlationStrips = (
	h: H,
	model: Model,
	service: GcpInfraServiceId,
	points: ReadonlyArray<BucketPoint>,
	range: GcpChartWindow,
	maxConnections: number | null,
	ctx: ChartsContext,
): Html => {
	const strips = gcpWorkloadStrips(service, points, range, maxConnections)
	const xDomain = gcpStripDomain(points, range.bucketSeconds)
	return h.section(
		[
			h.Class(cn(panelStyles, panelToneStyles.default, "block")),
			h.DataAttribute("slot", "panel"),
			h.Style(LINKED_CURSOR_STYLE),
			h.OnMount(MountLinkedCursor()),
		],
		strips.map((strip, index) =>
			h.div(
				[h.Class(cn("flex items-center gap-4 px-4 py-3", index > 0 && "border-t"))],
				[
					h.div(
						[h.Class("flex w-[140px] shrink-0 flex-col gap-0.5")],
						[
							h.span([h.Class("text-xs font-medium text-foreground")], [strip.label]),
							h.span([h.Class("font-mono text-3xs text-muted-foreground")], [strip.source]),
							h.div([h.Class("mt-2 flex flex-col gap-0.5")], summaryView(h, strip.summary)),
						],
					),
					h.div(
						[h.Class("min-w-0 flex-1")],
						[
							chart(h, model, `gcp-strip-${strip.id}`, {
								spec: InfraMetricChart.infraMetricSpec({
									rows: strip.rows,
									unit: strip.unit,
									seriesLabel: strip.label,
									showThreshold: strip.threshold,
									xDomain,
									seriesColors: strip.colors,
									theme: ctx.theme,
									timeZone: ctx.timeZone,
									gradientPrefix: `gcp-strip-${strip.id}`,
								}),
								linkedChartId: `lens-gcp-${strip.id}`,
								height: STRIP_HEIGHT,
							}),
						],
					),
				],
			),
		),
	)
}

/** `GcpWorkloadCharts`: every chart of a read, each linking its metric into the explorer. */
export const workloadCharts = (
	h: H,
	model: Model,
	options: Readonly<{
		charts: ReadonlyArray<GcpChart>
		points: ReadonlyArray<BucketPoint>
		range: GcpChartWindow
		where: string
		timeSearch: TimeSearch
		idPrefix: string
	}>,
	ctx: ChartsContext,
): Html => {
	const { charts, points, range } = options
	const xDomain = gcpBuckets(points, range.bucketSeconds).map(({ bucket }) => bucket)
	return h.div(
		[
			h.Class("grid grid-cols-1 gap-4 lg:grid-cols-2"),
			h.Style(LINKED_CURSOR_STYLE),
			h.OnMount(MountLinkedCursor()),
		],
		charts.map((spec) => {
			const rows =
				spec.kind === "classes"
					? gcpClassRows(spec.metric, points, range)
					: gcpLineRows(spec.series, points, range)
			const metric = gcpChartMetric(spec, points)
			const explore = h.a(
				[
					h.AriaLabel(`Open ${metric.name} in the metrics explorer`),
					h.Class("text-muted-foreground/60 transition-colors hover:text-foreground"),
					h.Href(
						hrefOf(
							AppRoute.Metric({
								metricName: metric.name,
								search: {
									...options.timeSearch,
									type: metric.type,
									where: options.where,
									groupBy: metric.groupBy,
								},
							}),
						),
					),
					h.Title(`Open ${metric.name} in the metrics explorer`),
				],
				[icon(h, "ChartLineIcon", { size: 12 })],
			)
			if (rows.length === 0) {
				return chartCard(h, { title: spec.title, scope: explore }, [
					chartCardMessage(h, spec.note ?? InfraMetricChart.CHART_EMPTY_MESSAGE),
				])
			}
			const names = [...new Set(rows.map((row) => row.attributeValue))]
			const colors = resolveSeriesColors(names)
			return chartCard(
				h,
				{
					title: spec.title,
					scope: explore,
					legend:
						names.length > 1 || spec.kind === "classes"
							? seriesLegend(h, {
									swatch: "line",
									items: names.map((name) => ({
										key: name,
										label: name,
										color: colors.get(name),
									})),
								})
							: undefined,
				},
				[
					chart(h, model, `${options.idPrefix}-${spec.title}`, {
						spec: InfraMetricChart.infraMetricSpec({
							rows,
							unit: spec.kind === "classes" ? "rate" : spec.unit,
							showThreshold: spec.kind === "lines" && spec.threshold === true,
							xDomain,
							gaps: true,
							theme: ctx.theme,
							timeZone: ctx.timeZone,
							gradientPrefix: `${options.idPrefix}-${spec.title.replace(/\W+/g, "_")}`,
						}),
						linkedChartId: `gcp-${spec.title}`,
						height: CHART_HEIGHT,
					}),
				],
			)
		}),
	)
}
