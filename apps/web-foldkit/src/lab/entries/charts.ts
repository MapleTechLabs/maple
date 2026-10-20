import { pickValueField, toBreakdownRows } from "@maple/ui/components/charts/_shared/breakdown-rows"
import { heatmapSampleData, pieSampleData } from "@maple/ui/components/charts/_shared/sample-data"
import {
	STACKED_BAR_SPIKE_ROWS,
	TIMESERIES_PARTIAL_ROWS,
	TIMESERIES_SPIKE_ROWS,
	toLatencyProductionRows,
	toStackedBarProductionRows,
	toThroughputProductionRows,
} from "../charts/timeseries-data"
import { Clock, Effect, Option, Schema } from "effect"
import { Command, Mount, Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import * as Chart from "../../charts/chart"
import {
	ChartRuntime,
	ChartRuntimeMessage,
	isChartRuntimeReady,
	LoadChartRuntime,
} from "../../charts/chart-runtime"
import * as AreaChart from "../../charts/area-chart"
import * as BarChart from "../../charts/bar-chart"
import * as HeatmapChart from "../../charts/heatmap-chart"
import * as HistogramChart from "../../charts/histogram-chart"
import * as PieChart from "../../charts/pie-chart"
import { ResolveThemeColors, ThemeColors, ThemeMessage } from "../../charts/theme-colors"
import { eyebrow } from "../../ui/eyebrow"
import { chartEmpty } from "../../ui/chart-state"
import { widgetShell } from "../../page/dashboards/kit/tile-shell"
import { inlineCode } from "../../ui/inline-code"
import { ARM_TITLES, type ChartsLabArm, SECTIONS } from "../charts/arms"
import {
	histogramSpikeValues,
	histogramSpikeView,
	pieLegendSpikeView,
	pieSpikeView,
	SPIKE_TOKENS,
} from "../charts/spikes"
import { SPIKE_ARMS, SPIKE_TOKENS_ALL } from "../charts/spike-arms"
import { spikeView } from "../charts/spike-view"
import { defineLab } from "../define"
import { foldLabToasts, initLabToasts, labRoot } from "../toasts"
import * as Toast from "../../ui/toast"

// `/lab/charts`: the gallery, canvas renderer.

const PRODUCTION_CHART_CLASS = "h-full w-full aspect-auto"
const pieRows = toBreakdownRows(pieSampleData, pickValueField(pieSampleData)).map((row) => ({
	name: row.name,
	value: row.value,
}))
const histogramProductionRows: ReadonlyArray<Record<string, unknown>> = histogramSpikeValues.map((value) => ({
	value,
}))

type ChartRow = Readonly<Record<string, string | number | boolean>>

/** The production rows narrowed to the scalar cells the timeseries charts read. */
const scalarRows = (rows: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<ChartRow> =>
	rows.map((row) =>
		Object.fromEntries(
			Object.entries(row).flatMap(([key, value]) =>
				typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? [[key, value]] : [],
			),
		),
	)

/** The production timeseries arms: `QueryBuilderLineChart`, `QueryBuilderAreaChart`, stacked bars. */
const PRODUCTION_TIMESERIES = {
	"line-production": { kind: "line", rows: scalarRows(toLatencyProductionRows(TIMESERIES_SPIKE_ROWS)) },
	"line-incomplete-production": { kind: "line", rows: scalarRows(toLatencyProductionRows(TIMESERIES_PARTIAL_ROWS)) },
	"area-production": { kind: "area", rows: scalarRows(toThroughputProductionRows(TIMESERIES_SPIKE_ROWS)) },
	"area-incomplete-production": { kind: "area", rows: scalarRows(toThroughputProductionRows(TIMESERIES_PARTIAL_ROWS)) },
	"stacked-bar-production": { kind: "bar", rows: scalarRows(toStackedBarProductionRows(STACKED_BAR_SPIKE_ROWS)) },
} satisfies Partial<Record<ChartsLabArm, Readonly<{ kind: "line" | "area" | "bar"; rows: ReadonlyArray<ChartRow> }>>>

const productionTimeseriesOf = (arm: ChartsLabArm) => {
	switch (arm) {
		case "line-production":
		case "line-incomplete-production":
		case "area-production":
		case "area-incomplete-production":
		case "stacked-bar-production":
			return PRODUCTION_TIMESERIES[arm]
		default:
			return undefined
	}
}

/** One chart instance per gallery position, section and row (an arm can repeat in a section). */
const slotOf = (position: string, arm: ChartsLabArm): string => `${position}:${arm}`

const PORTED_ARMS: ReadonlyArray<ChartsLabArm> = [
	"heatmap-production",
	"line-production",
	"area-production",
	"stacked-bar-production",
	"line-incomplete-production",
	"area-incomplete-production",
	"pie-production",
	"pie-tanstack",
	"pie-solid-tanstack",
	"pie-legend-tanstack",
	"pie-solid-legend-tanstack",
	"histogram-production",
	"histogram-tanstack",
]
const isPorted = (arm: ChartsLabArm): boolean => PORTED_ARMS.includes(arm) || SPIKE_ARMS.has(arm)

const THEME_TOKENS: ReadonlyArray<string> = [
	...new Set([
		...PieChart.pieChartTokens(pieSampleData),
		...SPIKE_TOKENS,
		...SPIKE_TOKENS_ALL,
		HistogramChart.HISTOGRAM_BAR_TOKEN,
		...AreaChart.AREA_CHART_TOKENS,
		...BarChart.BAR_CHART_TOKENS,
		...HeatmapChart.HEATMAP_TOKENS,
		"--border",
	]),
]

// MODEL

const Model = Schema.Struct({
	maybeTheme: Schema.Option(ThemeColors),
	chartRuntime: ChartRuntime,
	charts: Schema.Record(Schema.String, Chart.Model),
	/** The capture clock the production charts judge an in-flight tail against. */
	nowMs: Schema.Number,
	toasts: Toast.Model,
})
type Model = typeof Model.Type

const init = (): Update.Return<Model, Message> => ({
	model: {
		maybeTheme: Option.none(),
		chartRuntime: ChartRuntime.Loading(),
		nowMs: 0,
		charts: Object.fromEntries(
			SECTIONS.flatMap((section, sectionIndex) =>
				section.rows.flatMap((row, rowIndex) =>
					row.filter(isPorted).map((arm) => [slotOf(`${sectionIndex}.${rowIndex}`, arm), Chart.init()]),
				),
			),
		),
		toasts: initLabToasts(),
	},
	commands: [
		...Command.mapMessages([LoadChartRuntime()], (message) => Message.GotChartRuntimeMessage({ message })),
		ReadClock(),
	],
})

// MESSAGE

const Message = defineMessageUnion({
	ResolvedThemeColors: { colors: ThemeColors },
	GotChartRuntimeMessage: { message: ChartRuntimeMessage },
	GotChartMessage: { slot: Schema.String, message: Chart.Message },
	GotToastMessage: { message: Toast.Message },
	CompletedReadClock: { nowMs: Schema.Number },
})
type Message = typeof Message.Type

const ReadClock = Command.define("ReadChartsLabClock", {
	messages: [Message.CompletedReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedReadClock({ nowMs })),
})

// UPDATE

const foldChart = Update.foldChildAt({
	update: Chart.update,
	readAt: (model: Model, slot: string) => Option.fromNullishOr(model.charts[slot]),
	writeAt: (model, slot, nextChart) =>
		modifyFields(model, { charts: (charts) => ({ ...charts, [slot]: nextChart }) }),
	toParentMessage: (slot, message) => Message.GotChartMessage({ slot, message }),
})

const foldToasts = foldLabToasts<Model, Message>((message) => Message.GotToastMessage({ message }))

const update = (model: Model, message: Message) =>
	Message.match<Update.Return<Model, Message>>(message, {
		ResolvedThemeColors: ({ colors }) => ({
			model: modifyFields(model, { maybeTheme: () => Option.some(colors) }),
		}),
		GotChartRuntimeMessage: ({ message }) => ({
			model: modifyFields(model, {
				chartRuntime: () =>
					ChartRuntimeMessage.match(message, {
						CompletedLoadChartRuntime: () => ChartRuntime.Ready(),
						FailedLoadChartRuntime: ({ reason }) => ChartRuntime.Failed({ reason }),
					}),
			}),
		}),
		GotChartMessage: ({ slot, message }) => foldChart(model, slot, message),
		GotToastMessage: ({ message }) => foldToasts(model, message),
		CompletedReadClock: ({ nowMs }) => ({ model: modifyFields(model, { nowMs: () => nowMs }) }),
	})

// VIEW

const toChartMessage = (slot: string) => (message: Chart.Message) =>
	Message.GotChartMessage({ slot, message })

/** The `cards[arm].node` of a ported arm; unported arms render an empty body for now. */
const chartNode = (
	model: Model,
	h: HtmlBuilder<Message>,
	theme: ThemeColors,
	slot: string,
	arm: ChartsLabArm,
): ReadonlyArray<Html> => {
	const chart = model.charts[slot]
	if (chart === undefined) return []
	const common = { slotId: slot, model: chart, toParentMessage: toChartMessage(slot) }
	const chartId = slot.replace(/[:.]/g, "-")
	if (arm === "pie-production") {
		const viewInputs = {
			chartId,
			data: pieSampleData,
			theme,
			legend: "right",
			tooltip: "visible",
			className: PRODUCTION_CHART_CLASS,
		} as const
		return [h.submodel({ ...common, view: PieChart.view, viewInputs })]
	}
	if (arm === "pie-tanstack" || arm === "pie-solid-tanstack") {
		const viewInputs = {
			chartId,
			rows: pieRows,
			theme,
			donut: arm === "pie-tanstack",
			className: "h-full w-full",
		}
		return [h.submodel({ ...common, view: pieSpikeView, viewInputs })]
	}
	if (arm === "histogram-production") {
		const viewInputs = {
			chartId,
			data: histogramProductionRows,
			theme,
			tooltip: "visible",
			className: PRODUCTION_CHART_CLASS,
		} as const
		return [h.submodel({ ...common, view: HistogramChart.view, viewInputs })]
	}
	if (arm === "heatmap-production") {
		const viewInputs = { chartId, data: heatmapSampleData, theme, tooltip: "visible", className: PRODUCTION_CHART_CLASS } as const
		return [h.submodel({ ...common, view: HeatmapChart.view, viewInputs })]
	}
	const timeseries = productionTimeseriesOf(arm)
	if (timeseries !== undefined) {
		const base = { chartId, data: timeseries.rows, theme, nowMs: model.nowMs, showTooltip: true, className: PRODUCTION_CHART_CLASS }
		return timeseries.kind === "bar"
			? [h.submodel({ ...common, view: BarChart.view, viewInputs: { ...base, stacked: true } })]
			: [h.submodel({ ...common, view: AreaChart.view, viewInputs: { ...base, mark: timeseries.kind } })]
	}
	if (arm === "pie-legend-tanstack" || arm === "pie-solid-legend-tanstack") {
		const viewInputs = { chartId, rows: pieRows, theme, donut: arm === "pie-legend-tanstack", className: "h-full w-full" }
		return [h.submodel({ ...common, view: pieLegendSpikeView, viewInputs })]
	}
	const spike = SPIKE_ARMS.get(arm)
	if (spike !== undefined) {
		const legend = spike.legend
		const viewInputs = {
			chartId,
			arm,
			theme,
			tokens: spike.tokens,
			ariaLabel: spike.ariaLabel,
			className: "h-full w-full",
			...(spike.footer === undefined ? undefined : { footer: spike.footer }),
			...(legend === undefined ? undefined : { legend: { label: legend.label, series: legend.series(theme) } }),
		}
		return [h.submodel({ ...common, view: spikeView, viewInputs })]
	}
	if (arm === "histogram-tanstack") {
		const viewInputs = { chartId, values: histogramSpikeValues, theme, className: "h-full w-full" }
		return [h.submodel({ ...common, view: histogramSpikeView, viewInputs })]
	}
	return []
}

const chartArm = (
	model: Model,
	h: HtmlBuilder<Message>,
	theme: ThemeColors,
	position: string,
	arm: ChartsLabArm,
): Html =>
	h.div(
		[h.DataAttribute("chart-arm", arm), h.Class("flex flex-col rounded-xl border bg-card")],
		[
			h.div(
				[h.Class("border-b px-4 py-2 font-medium text-muted-foreground text-xs")],
				[ARM_TITLES[arm]],
			),
			h.div(
				[h.Class("h-[320px] min-h-0 overflow-hidden p-2")],
				chartNode(model, h, theme, slotOf(position, arm), arm),
			),
		],
	)

const sectionRow = (
	model: Model,
	h: HtmlBuilder<Message>,
	theme: ThemeColors,
	position: string,
	arms: ReadonlyArray<ChartsLabArm>,
): Html => {
	const [only] = arms
	if (arms.length === 1 && only !== undefined) return chartArm(model, h, theme, position, only)
	return h.div(
		[h.Class("grid grid-cols-1 gap-4 lg:grid-cols-2")],
		arms.map((arm) => chartArm(model, h, theme, position, arm)),
	)
}

const section = (h: HtmlBuilder<Message>, title: string, children: ReadonlyArray<Html>): Html =>
	h.section(
		[h.Class("mb-8")],
		[
			eyebrow(h, { variant: "label", as: "h2", className: "mb-3" }, [title]),
			h.div([h.Class("grid gap-4")], children),
		],
	)

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	labRoot(h, model.toasts, (message) => Message.GotToastMessage({ message }), page(model, h))

const page = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[
			h.DataAttribute("testid", "charts-lab"),
			h.DataAttribute("charts-lab-renderer", "tanstack-canvas"),
			h.DataAttribute("charts-lab-arm", "gallery"),
			h.Class("min-h-screen bg-background p-6 text-foreground"),
			h.OnMount(Mount.mapMessage(ResolveThemeColors({ tokens: THEME_TOKENS }), toThemeMessage)),
		],
		Option.match(readyTheme(model), {
			onNone: () => [],
			onSome: (theme) => gallery(model, h, theme),
		}),
	)

/** `MetricsGrid` handed no rows: each card says so over bare axes (the service-detail grid, empty). */
const emptyMetricsGrid = (h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.DataAttribute("metrics-grid", ""), h.Class("grid grid-cols-1 md:grid-cols-2 gap-3")],
		["Latency", "Throughput", "Apdex", "Error Rate"].map((title) =>
			h.div(
				[h.Class("h-[240px] md:h-[280px]")],
				[
					widgetShell(
						h,
						{ widgetId: title, hasGrip: false, title, isEdit: false, menu: null, isMenuOpen: false, contentClassName: undefined },
						[chartEmpty(h, { hint: "Try a wider time range" }, ["No data in this window"])],
					),
				],
			),
		),
	)

/** The page itself, painted in one go once the theme is read and the chart library is loaded. */
const gallery = (model: Model, h: HtmlBuilder<Message>, theme: ThemeColors): ReadonlyArray<Html> => [
	h.header(
		[h.Class("mb-6")],
		[
			h.h1([h.Class("font-semibold text-lg")], ["TanStack charts"]),
			h.p(
				[h.Class("text-muted-foreground text-sm")],
				[
					"Production on the left, TanStack on the right, same rows.",
					inlineCode(h, { className: "ml-2 px-1.5 py-0.5 text-xs" }, [
						"?renderer=tanstack-svg|tanstack-canvas&arm=<chart>-<impl>",
					]),
				],
			),
		],
	),
	...SECTIONS.map((entry, sectionIndex) =>
		section(
			h,
			entry.title,
			entry.rows.map((arms, rowIndex) => sectionRow(model, h, theme, `${sectionIndex}.${rowIndex}`, arms)),
		),
	),
	section(h, "Empty window — MetricsGrid", [h.div([h.DataAttribute("testid", "charts-lab-empty")], [emptyMetricsGrid(h)])]),
]

const readyTheme = (model: Model): Option.Option<ThemeColors> =>
	Option.filter(model.maybeTheme, () => isChartRuntimeReady(model.chartRuntime) && model.nowMs > 0)

const toThemeMessage = (message: ThemeMessage): Message =>
	ThemeMessage.match(message, {
		ResolvedThemeColors: ({ colors }) => Message.ResolvedThemeColors({ colors }),
	})

export const lab = defineLab<Model, Message>("TanStack charts", { Model, init, update, view })
