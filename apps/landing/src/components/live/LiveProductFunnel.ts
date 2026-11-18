import * as Chart from "@maple/views/charts/chart"
import * as FunnelChart from "@maple/views/charts/funnel-chart"
import * as FunnelDropoffChart from "@maple/views/charts/funnel-dropoff-chart"
import { fmtSpan } from "@maple/views/charts/funnel-dropoff-steps"
import { formatNumber, formatPercent } from "@maple/ui/lib/format"
import { panel, panelChartBody, panelHeader } from "@maple/views/ui/panel"
import { panelTitleStyles } from "@maple/views/ui/panel.styles"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { statFigure } from "@maple/views/ui/stat-figure"
import { Option, Schema } from "effect"
import type { Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { makeIsland } from "../../foldkit-island/island"
import { biggestDrop, FUNNEL } from "./live-product-data"

// The dashboard's Product analytics funnel over an invented signup week, drawn by the same
// `@maple/views` funnel views the page uses. Hover a column for its drop-off and timing.

const ChartView = Schema.Literals(["dropoff", "bars"])
type ChartView = typeof ChartView.Type

// MODEL

const Model = Schema.Struct({ chart: Chart.Model, chartView: ChartView })
type Model = typeof Model.Type

// MESSAGE

const Message = defineMessageUnion({
	PickedChartView: { chartView: ChartView },
	GotChartMessage: { message: Chart.Message },
})
type Message = typeof Message.Type

type H = HtmlBuilder<Message>

/** `panelTitle` as a span: the blog's article styles restyle every `h3` inside it. */
const title = (h: H, children: ReadonlyArray<string>): Html => h.span([h.Class(panelTitleStyles)], children)

// UPDATE

const update = (model: Model, message: Message): Update.Return<Model, Message> =>
	Message.match<Update.Return<Model, Message>>(message, {
		// A new chart starts from an empty hover: the old one's hovered key means nothing to it.
		PickedChartView: ({ chartView }) => ({ model: { chart: Chart.init(), chartView } }),
		GotChartMessage: ({ message: inner }) => ({
			model: { ...model, chart: Chart.update(model.chart, inner).model },
		}),
	})

// VIEW

const first = FUNNEL[0]
const last = FUNNEL[FUNNEL.length - 1]
const entered = first?.value ?? 0
const converted = last?.value ?? 0

const stats = (h: H): Html =>
	h.div(
		[h.Class("grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4")],
		[
			statFigure(h, {
				label: "Entered",
				value: formatNumber(entered),
				caption: "people reached step 1",
			}),
			statFigure(h, {
				label: "Conversion",
				value: formatPercent(entered > 0 ? converted / entered : 0),
				caption: `${formatNumber(converted)} reached ${last?.name ?? ""}`,
			}),
			statFigure(h, {
				label: "Time to convert",
				value: last?.sinceStartP50Ms === undefined ? "–" : fmtSpan(last.sinceStartP50Ms),
				caption: "median",
			}),
			...Option.match(biggestDrop(FUNNEL), {
				onNone: () => [],
				onSome: (drop) => [
					statFigure(h, {
						label: "Biggest drop",
						value: formatPercent(drop.share),
						caption: `before ${drop.name}`,
					}),
				],
			}),
		],
	)

const chart = (h: H, model: Model): Html => {
	const common = {
		slotId: "landing-product-funnel",
		model: model.chart,
		toParentMessage: (message: Chart.Message) => Message.GotChartMessage({ message }),
	}
	const inputs = {
		data: FUNNEL,
		className: model.chartView === "dropoff" ? "h-80" : "h-60",
		isSingleHue: true,
	}
	return model.chartView === "dropoff"
		? h.submodel({ ...common, view: FunnelDropoffChart.view, viewInputs: inputs })
		: h.submodel({ ...common, view: FunnelChart.view, viewInputs: inputs })
}

const view = (model: Model, h: H): Html =>
	h.div(
		[h.Class("live-frame")],
		[
			h.div(
				[h.Class("live-frame__head")],
				[
					h.span([], ["/product-analytics · funnels · last 7 days"]),
					h.span(
						[h.Class("live-frame__live")],
						[h.span([h.Class("live-frame__live-dot")], []), "DEMO"],
					),
				],
			),
			// The frame is set in mono for its head; the page inside reads in the product's face.
			h.div(
				[h.Class("grid grid-cols-1 gap-4 bg-background p-3 font-sans text-foreground sm:p-5")],
				[
					stats(h),
					panel(h, {}, [
						panelHeader(h, {
							divided: false,
							className: "px-3 pt-2.5",
							children: [
								title(h, ["Signup to paid plan, counted by person"]),
								segmentedSelect(h, {
									ariaLabel: "Chart",
									size: "sm",
									value: model.chartView,
									options: [
										{ value: "bars", label: "Bars" },
										{ value: "dropoff", label: "Drop-off" },
									],
									onChange: (chartView) => Message.PickedChartView({ chartView }),
								}),
							],
						}),
						panelChartBody(h, [chart(h, model)]),
					]),
				],
			),
		],
	)

const INITIAL: Model = { chart: Chart.init(), chartView: "dropoff" }

export const LiveProductFunnel = makeIsland({
	name: "live-product-funnel",
	Props: Schema.Struct({}),
	Model,
	init: () => ({ model: INITIAL }),
	update,
	view,
})
