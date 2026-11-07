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
import { panel } from "@maple/views/ui/panel"
import * as Chart from "@maple/views/charts/chart"
import * as InfraMetricChart from "@maple/views/charts/infra-metric-chart"
import type { ThemeColors } from "@maple/views/charts/theme-colors"
import { AppRoute, hrefOf } from "../../../../route"
import { icon } from "@maple/views/ui/icon"
import { CHART_HEIGHT, chartCard, chartCardMessage } from "../../kit/chart-card"
import { LINKED_CURSOR_STYLE } from "@maple/views/charts/linked-cursor"
import { seriesLegend } from "../../../kit/series-legend"
import type { BucketPoint } from "../data"
import { MountLinkedCursor } from "./command"
import { Message, type Model } from "./model"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstackClass, vstack } from "@maple/views/ui/stack"
import { gridClass } from "@maple/views/ui/grid"
import { Array as Arr, String as Str } from "effect"

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
					typographyClass({
						size: "sm",
						tone: "foreground",
						weight: "semibold",
						mono: true,
						numeric: true,
					}),
					summary.alert === true && "text-severity-error",
				),
			),
		],
		[summary.value],
	),
	...(summary.caption === undefined
		? []
		: [typography(h, { size: "3xs", tone: "muted", mono: true }, [summary.caption])]),
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
	return panel(
		h,
		{ className: "block", attributes: [h.Style(LINKED_CURSOR_STYLE), h.OnMount(MountLinkedCursor())] },
		Arr.map(strips, (strip, index) => {
			const { spec, info } = InfraMetricChart.infraMetricModel({
				rows: strip.rows,
				unit: strip.unit,
				seriesLabel: strip.label,
				showThreshold: strip.threshold,
				xDomain,
				seriesColors: strip.colors,
				theme: ctx.theme,
				timeZone: ctx.timeZone,
				gradientPrefix: `gcp-strip-${strip.id}`,
			})
			return h.div(
				[h.Class(cn(hstackClass({ gap: "4", className: "px-4 py-3" }), index > 0 && "border-t"))],
				[
					vstack(h, { gap: "0.5", className: "w-36 shrink-0" }, [
						h.span([h.Class("font-prose text-xs font-medium text-foreground")], [strip.label]),
						h.span([h.Class("font-prose text-3xs text-muted-foreground")], [strip.source]),
						vstack(h, { gap: "0.5", className: "mt-2" }, summaryView(h, strip.summary)),
					]),
					h.div(
						[h.Class("min-w-0 flex-1")],
						[
							chart(h, model, `gcp-strip-${strip.id}`, {
								spec,
								linkedChartId: `lens-gcp-${strip.id}`,
								height: STRIP_HEIGHT,
							}),
							// More than one line on a strip needs a key; one line is named by the label.
							...(info.series.length > 1
								? [
										seriesLegend(h, {
											swatch: "line",
											className: "pt-1",
											items: Arr.map(info.series, (name) => ({
												key: name,
												label: info.labelFor(name),
												color: info.colors.get(name),
											})),
										}),
									]
								: []),
						],
					),
				],
			)
		}),
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
	const xDomain = Arr.map(gcpBuckets(points, range.bucketSeconds), ({ bucket }) => bucket)
	return h.div(
		[
			h.Class(gridClass({ cols: 1, lg: 2, gap: "4" })),
			h.Style(LINKED_CURSOR_STYLE),
			h.OnMount(MountLinkedCursor()),
		],
		Arr.map(charts, (spec) => {
			const rows =
				spec.kind === "classes"
					? gcpClassRows(spec.metric, points, range)
					: gcpLineRows(spec.series, points, range)
			const metric = gcpChartMetric(spec, points)
			const explore = h.a(
				[
					h.AriaLabel(`Open ${metric.name} in the metrics explorer`),
					h.Class("text-foreground-subtle hover:text-foreground active:text-foreground"),
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
			const names = [...new Set(Arr.map(rows, (row) => row.attributeValue))]
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
									items: Arr.map(names, (name) => ({
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
							gradientPrefix: `${options.idPrefix}-${Str.replace(/\W+/g, "_")(spec.title)}`,
						}),
						linkedChartId: `gcp-${spec.title}`,
						height: CHART_HEIGHT,
					}),
				],
			)
		}),
	)
}
