import { pickValueField, toBreakdownRows } from "@maple/ui/components/charts/_shared/breakdown-rows"
import { pieSampleData } from "@maple/ui/components/charts/_shared/sample-data"
import { Option, Schema } from "effect"
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
import * as HistogramChart from "../../charts/histogram-chart"
import * as PieChart from "../../charts/pie-chart"
import { ResolveThemeColors, ThemeColors, ThemeMessage } from "../../charts/theme-colors"
import { eyebrow } from "../../ui/eyebrow"
import { inlineCode } from "../../ui/inline-code"
import { ARM_TITLES, type ChartsLabArm, SECTIONS } from "../charts/arms"
import { histogramSpikeValues, histogramSpikeView, pieSpikeView, SPIKE_TOKENS } from "../charts/spikes"
import { defineLab } from "../define"
import { foldLabToasts, initLabToasts, labRoot } from "../toasts"
import * as Toast from "../../ui/toast"

// Port of `/lab/charts` (apps/web/src/lab/charts/charts-lab.tsx): the gallery, canvas renderer.

const PRODUCTION_CHART_CLASS = "h-full w-full aspect-auto"
const pieRows = toBreakdownRows(pieSampleData, pickValueField(pieSampleData)).map((row) => ({
	name: row.name,
	value: row.value,
}))
const histogramProductionRows: ReadonlyArray<Record<string, unknown>> = histogramSpikeValues.map((value) => ({
	value,
}))

/** One chart instance per gallery position (`pie-production` renders in two sections). */
const slotOf = (sectionIndex: number, arm: ChartsLabArm): string => `${sectionIndex}:${arm}`

const PORTED_ARMS: ReadonlyArray<ChartsLabArm> = [
	"pie-production",
	"pie-tanstack",
	"pie-solid-tanstack",
	"histogram-production",
	"histogram-tanstack",
]
const isPorted = (arm: ChartsLabArm): boolean => PORTED_ARMS.includes(arm)

const THEME_TOKENS: ReadonlyArray<string> = [
	...new Set([
		...PieChart.pieChartTokens(pieSampleData),
		...SPIKE_TOKENS,
		HistogramChart.HISTOGRAM_BAR_TOKEN,
		"--border",
	]),
]

// MODEL

const Model = Schema.Struct({
	maybeTheme: Schema.Option(ThemeColors),
	chartRuntime: ChartRuntime,
	charts: Schema.Record(Schema.String, Chart.Model),
	toasts: Toast.Model,
})
type Model = typeof Model.Type

const init = (): Update.Return<Model, Message> => ({
	model: {
		maybeTheme: Option.none(),
		chartRuntime: ChartRuntime.Loading(),
		charts: Object.fromEntries(
			SECTIONS.flatMap((section, sectionIndex) =>
				section.rows
					.flat()
					.filter(isPorted)
					.map((arm) => [slotOf(sectionIndex, arm), Chart.init()]),
			),
		),
		toasts: initLabToasts(),
	},
	commands: Command.mapMessages([LoadChartRuntime()], (message) =>
		Message.GotChartRuntimeMessage({ message }),
	),
})

// MESSAGE

const Message = defineMessageUnion({
	ResolvedThemeColors: { colors: ThemeColors },
	GotChartRuntimeMessage: { message: ChartRuntimeMessage },
	GotChartMessage: { slot: Schema.String, message: Chart.Message },
	GotToastMessage: { message: Toast.Message },
})
type Message = typeof Message.Type

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
	const chartId = slot.replace(":", "-")
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
	sectionIndex: number,
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
				chartNode(model, h, theme, slotOf(sectionIndex, arm), arm),
			),
		],
	)

const sectionRow = (
	model: Model,
	h: HtmlBuilder<Message>,
	theme: ThemeColors,
	sectionIndex: number,
	arms: ReadonlyArray<ChartsLabArm>,
): Html => {
	const [only] = arms
	if (arms.length === 1 && only !== undefined) return chartArm(model, h, theme, sectionIndex, only)
	return h.div(
		[h.Class("grid grid-cols-1 gap-4 lg:grid-cols-2")],
		arms.map((arm) => chartArm(model, h, theme, sectionIndex, arm)),
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
			entry.rows.map((arms) => sectionRow(model, h, theme, sectionIndex, arms)),
		),
	),
	section(h, "Empty window — MetricsGrid", [h.div([h.DataAttribute("testid", "charts-lab-empty")])]),
]

const readyTheme = (model: Model): Option.Option<ThemeColors> =>
	Option.filter(model.maybeTheme, () => isChartRuntimeReady(model.chartRuntime))

const toThemeMessage = (message: ThemeMessage): Message =>
	ThemeMessage.match(message, {
		ResolvedThemeColors: ({ colors }) => Message.ResolvedThemeColors({ colors }),
	})

export const lab = defineLab<Model, Message>("TanStack charts", { Model, init, update, view })
