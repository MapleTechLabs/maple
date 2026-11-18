import * as Chart from "@maple/views/charts/chart"
import * as PathsChart from "@maple/views/charts/paths-chart"
import { formatNumber } from "@maple/ui/lib/format"
import { panel, panelChartBody, panelHeader } from "@maple/views/ui/panel"
import { panelTitleStyles } from "@maple/views/ui/panel.styles"
import { typography } from "@maple/views/ui/typography"
import { Schema } from "effect"
import type { Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { makeIsland } from "../../foldkit-island/island"
import { PATHS, PATHS_ANCHOR, pathsTotal } from "./live-product-data"

// The dashboard's Product analytics paths over an invented signup week, drawn by the same
// `@maple/views` paths view the page uses. Hover a node to follow the people through it.

// MODEL

const Model = Schema.Struct({ chart: Chart.Model })
type Model = typeof Model.Type

// MESSAGE

const Message = defineMessageUnion({
	GotChartMessage: { message: Chart.Message },
})
type Message = typeof Message.Type

type H = HtmlBuilder<Message>

/** `panelTitle` as a span: the blog's article styles restyle every `h3` inside it. */
const title = (h: H, children: ReadonlyArray<string>): Html => h.span([h.Class(panelTitleStyles)], children)

// UPDATE

const update = (model: Model, message: Message): Update.Return<Model, Message> =>
	Message.match<Update.Return<Model, Message>>(message, {
		GotChartMessage: ({ message: inner }) => ({
			model: { chart: Chart.update(model.chart, inner).model },
		}),
	})

// VIEW

const view = (model: Model, h: H): Html =>
	h.div(
		[h.Class("live-frame")],
		[
			h.div(
				[h.Class("live-frame__head")],
				[
					h.span([], ["/product-analytics · paths · last 7 days"]),
					h.span(
						[h.Class("live-frame__live")],
						[h.span([h.Class("live-frame__live-dot")], []), "DEMO"],
					),
				],
			),
			// The frame is set in mono for its head; the page inside reads in the product's face.
			h.div(
				[h.Class("bg-background p-3 font-sans text-foreground sm:p-5")],
				[
					panel(h, {}, [
						panelHeader(h, {
							divided: false,
							className: "px-3 pt-2.5",
							children: [
								title(h, [`What people did after ${PATHS_ANCHOR}`]),
								typography(h, { size: "xs", tone: "muted", numeric: true }, [
									`${formatNumber(pathsTotal)} people`,
								]),
							],
						}),
						// The chart lays out once it has measured its box: the height holds it until then.
						panelChartBody(h, [
							h.submodel({
								slotId: "landing-product-paths",
								model: model.chart,
								view: PathsChart.view,
								viewInputs: { data: PATHS, className: "h-96", direction: "after" },
								toParentMessage: (message) => Message.GotChartMessage({ message }),
							}),
						]),
					]),
				],
			),
		],
	)

export const LiveProductPaths = makeIsland({
	name: "live-product-paths",
	Props: Schema.Struct({}),
	Model,
	init: () => ({ model: { chart: Chart.init() } }),
	update,
	view,
})
