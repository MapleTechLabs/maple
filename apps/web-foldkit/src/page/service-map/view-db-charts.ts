import type { Html, HtmlBuilder } from "foldkit/html"
import type { Message } from "./message"
import type { DbSummary, Model } from "./model"

// `DbQueryActivityChart`'s two plots: query volume (`QueryBuilderBarChart`) over latency
// (`LatencyLineChart`), joined by the linked cursor.
// TODO(db-charts): the plots are not ported yet; their frames hold the space.

type H = HtmlBuilder<Message>

export const queryActivityCharts = (h: H, _model: Model, _response: DbSummary["value"]): Html =>
	h.div(
		[h.Class("space-y-2")],
		[h.div([h.Class("relative h-32 w-full")], []), h.div([h.Class("relative h-32 w-full")], [])],
	)
