import type { MetricsQueryDraft } from "@maple/query-engine/query-builder"
import { countLabel, formatNumber } from "@maple/ui/lib/format"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as AreaChart from "../../../charts/area-chart"
import { isChartRuntimeReady } from "../../../charts/chart-runtime"
import type * as Chart from "../../../charts/chart"
import { chartSkeleton } from "../../../ui/chart-skeleton"
import type * as Combobox from "../../../ui/combobox"
import { view as comboboxView } from "../../../ui/combobox-view"
import { badge } from "../../../ui/display"
import { emptyMessage } from "../../../ui/empty"
import { errorState } from "../../../ui/error-state"
import { keyValue, keyValueList } from "../../../ui/key-value"
import { backdropBar } from "../../../ui/meter"
import { panel, panelHeader } from "../../../ui/panel"
import { skeleton, skeletonList } from "../../../ui/skeleton"
import { truncatedText } from "../../../ui/truncated-text"
import { metricTypeBadge } from "../shared"
import { formatSeen } from "../time-format"
import {
	breakdownAggregation,
	breakdownGroupBy,
	type CatalogSummary,
	chartUnitFromOtel,
	GROUP_BY_SERIES_LIMIT,
	queryLabel,
	SERVICE_KEY,
} from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { breakdownKeyOf } from "./update"

// `MetricChart`, `MetricBreakdown` and `MetricMetadataPanel` (components/metrics/).

type H = HtmlBuilder<Message>

const toChart = (message: Chart.Message) => Message.GotChartMessage({ message })
const toBreakdownKey = (message: Combobox.Message) => Message.GotBreakdownComboboxMessage({ message })

const chartBody = (h: H, model: Model, draft: MetricsQueryDraft, unit: string, timeZone: string): Html =>
	AsyncData.matchData(model.timeseries.data, {
		onEmpty: () => chartSkeleton(h, "area"),
		onFailure: (failure) => errorState(h, { failure, title: "Couldn't load metric data" }),
		onData: (rows) =>
			rows.length === 0
				? emptyMessage(h, { className: "flex h-full items-center justify-center" }, [
						"No datapoints match this query in the selected range.",
					])
				: model.themeColors === null || !isChartRuntimeReady(model.chartRuntime)
					? chartSkeleton(h, "area")
					: h.submodel({
							slotId: "metric-chart",
							model: model.chart,
							view: AreaChart.view,
							toParentMessage: toChart,
							viewInputs: {
								chartId: "metric-explorer",
								data: rows,
								theme: model.themeColors,
								unit: chartUnitFromOtel(unit),
								timeZone,
								nowMs: model.nowMs,
								className: "h-full w-full aspect-auto",
								showTooltip: true,
								legend: draft.groupBy.length > 0 ? "visible" : "hidden",
							},
						}),
	})

/** The cap runs in SQL, so it is flagged only when a grouped result reached it. */
const isCapped = (model: Model, draft: MetricsQueryDraft): boolean =>
	draft.groupBy.length > 0 &&
	AsyncData.isSuccess(model.timeseries.data) &&
	new Set(model.timeseries.data.data.flatMap((row) => Object.keys(row).filter((key) => key !== "bucket")))
		.size >= GROUP_BY_SERIES_LIMIT

/** `MetricChart` in its `ChartCard`. */
export const metricChart = (
	h: H,
	model: Model,
	draft: MetricsQueryDraft,
	unit: string,
	timeZone: string,
): Html => {
	const label = queryLabel(draft)
	const capped = isCapped(model, draft)
	return panel(h, {}, [
		panelHeader(h, {
			title: h.span([h.Class("font-mono"), h.Title(label)], [label]),
			action:
				capped || unit !== ""
					? h.span(
							[h.Class("flex items-center gap-3 text-xs text-muted-foreground")],
							[
								...(capped ? [h.span([], [`Top ${GROUP_BY_SERIES_LIMIT} series`])] : []),
								...(unit === "" ? [] : [h.span([], ["unit: ", unit])]),
							],
						)
					: undefined,
			divided: false,
			className: "px-3 pt-2.5",
		}),
		h.div([h.Class("h-80 p-3")], [chartBody(h, model, draft, unit, timeZone)]),
	])
}

const breakdownBars = (h: H, model: Model, filterKey: string): Html =>
	AsyncData.matchData(model.breakdown.data, {
		onEmpty: () => skeletonList(h, { rows: 5, rowClassName: "h-6", gap: "2" }),
		onFailure: (failure) =>
			errorState(h, { failure, title: "Couldn't load breakdown", variant: "inline" }),
		onData: (rows) => {
			if (rows.length === 0)
				return emptyMessage(h, {}, ["No values for this attribute in the selected range."])
			const max = Math.max(...rows.map((row) => row.value), 1)
			return h.div(
				[h.Class("space-y-1")],
				rows.map((row) =>
					h.button(
						[
							h.Key(row.name),
							h.Type("button"),
							h.Class(
								"group relative flex w-full items-center justify-between gap-3 rounded-sm px-2 py-1 text-left transition-colors hover:bg-accent",
							),
							h.OnClick(Message.ClickedBreakdownValue({ groupBy: filterKey, value: row.name })),
						],
						[
							backdropBar(h, {
								value: row.value,
								max,
								className:
									"inset-y-0.5 left-0 bg-primary/10 transition-colors group-hover:bg-primary/15",
							}) ?? h.empty,
							h.span([h.Class("sr-only")], ["Filter to ", filterKey, " = "]),
							truncatedText(h, {
								text: row.name,
								mono: true,
								className: "relative z-10 text-xs",
							}),
							h.span(
								[h.Class("relative z-10 shrink-0 font-mono text-xs text-muted-foreground")],
								[formatNumber(row.value)],
							),
						],
					),
				),
			)
		},
	})

const attributeKeyNames = (model: Model): ReadonlyArray<string> =>
	Option.match(AsyncData.getData(model.attributeKeys.data), {
		onNone: () => [],
		onSome: (rows) => rows.map((row) => row.attributeKey),
	})

/** `MetricBreakdown`: top values of one attribute; each bar narrows the where clause. */
export const metricBreakdown = (h: H, model: Model, draft: MetricsQueryDraft): Html => {
	const filterKey = breakdownGroupBy(breakdownKeyOf(model.search))
	return panel(h, {}, [
		panelHeader(h, {
			title: `Top values · ${breakdownAggregation(draft.aggregation)} per value`,
			action: h.submodel({
				slotId: "metric-breakdown-key",
				model: model.breakdownCombobox,
				view: comboboxView,
				toParentMessage: toBreakdownKey,
				viewInputs: {
					items: [SERVICE_KEY, ...attributeKeyNames(model)],
					placeholder: "Break down by…",
					emptyText: "",
					className: "h-7 w-52 text-xs",
					toView: ({ field, rest }) => h.div([h.Class("contents")], [field, ...rest]),
				},
			}),
		}),
		h.div([h.Class("p-3")], [breakdownBars(h, model, filterKey)]),
	])
}

const attributesList = (h: H, model: Model): Html =>
	AsyncData.matchData(model.attributeKeys.data, {
		onEmpty: () => skeleton(h, "h-12 w-full"),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Couldn't load attribute keys",
				variant: "inline",
				className: "py-1",
			}),
		onData: (rows) =>
			rows.length === 0
				? h.p(
						[h.Class("text-xs text-muted-foreground")],
						["This metric has no datapoint attributes."],
					)
				: h.ul(
						[h.Class("space-y-1")],
						rows.map((row) =>
							h.li(
								[
									h.Key(row.attributeKey),
									h.Class("flex items-center justify-between gap-2 text-xs"),
								],
								[
									h.span([h.Class("truncate font-mono")], [row.attributeKey]),
									h.span(
										[h.Class("shrink-0 font-mono text-muted-foreground")],
										[formatNumber(row.usageCount)],
									),
								],
							),
						),
					),
	})

/** `MetricMetadataPanel`. */
export const metadataPanel = (h: H, model: Model, summary: CatalogSummary, timeZone: string): Html =>
	panel(h, { className: "gap-4 p-3" }, [
		h.div(
			[h.Class("space-y-2")],
			[
				h.div(
					[h.Class("flex flex-wrap items-center gap-2")],
					[
						metricTypeBadge(h, summary.metricType),
						...(summary.unit === ""
							? []
							: [badge(h, { variant: "outline", size: "xs", mono: true }, [summary.unit])]),
						...(summary.metricType === "sum"
							? [
									badge(h, { variant: "outline", size: "xs" }, [
										summary.isMonotonic ? "monotonic" : "non-monotonic",
									]),
								]
							: []),
					],
				),
				...(summary.description === ""
					? []
					: [h.p([h.Class("text-xs text-muted-foreground")], [summary.description])]),
			],
		),
		keyValueList(h, { className: "gap-2" }, [
			keyValue(h, { label: "Datapoints in range", mono: true }, [formatNumber(summary.dataPointCount)]),
			keyValue(h, { label: "First seen", mono: true }, [formatSeen(summary.firstSeen, timeZone)]),
			keyValue(h, { label: "Last seen", mono: true }, [formatSeen(summary.lastSeen, timeZone)]),
		]),
		...(summary.services.length === 0
			? []
			: [
					h.div(
						[h.Class("space-y-1.5")],
						[
							h.p(
								[h.Class("text-xs text-muted-foreground")],
								["Emitted by ", countLabel(summary.services.length, "service")],
							),
							h.div(
								[h.Class("flex flex-wrap gap-1.5")],
								summary.services.map((service) =>
									badge(
										h,
										{
											variant: "outline",
											size: "xs",
											mono: true,
											className: "max-w-full",
											attributes: [h.Title(service)],
										},
										[h.span([h.Class("min-w-0 truncate")], [service])],
									),
								),
							),
						],
					),
				]),
		h.div(
			[h.Class("space-y-1.5")],
			[h.p([h.Class("text-xs text-muted-foreground")], ["Attributes"]), attributesList(h, model)],
		),
	])
