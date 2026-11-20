import { OrgId } from "@maple/domain"
import { Array as Arr, Effect, Result, Schema } from "effect"
import { parseWarehouseDateTime } from "@maple/query-engine"
import type { Html, HtmlBuilder } from "foldkit/html"
import { chartSkeleton } from "@maple/views/ui/chart-skeleton"
import { typography } from "@maple/views/ui/typography"
import type { PageContext } from "../../page/contract"
import type { WidgetDataState } from "../../page/dashboards/kit/data-state"
import { widgetFrame } from "../../page/dashboards/kit/tile-shell"
import { Message as DetailMessage } from "../../page/metrics/detail/message"
import type { Model as DetailModel } from "../../page/metrics/detail/model"
import { init as detailInit, summaryOf, update as detailUpdate } from "../../page/metrics/detail/update"
import { metadataPanel } from "../../page/metrics/detail/view-panels"
import type { MetricRow } from "../../page/metrics/shared"
import { defineLabWithFlags } from "../define"

// `/lab/promql-hints?view=tiles|metric`: PromQL warnings on dashboard tiles (an empty tile with the
// nearest-name hint, a tile with data and a header warning) and a metric's PromQL names on its detail.

const View = Schema.Literals(["tiles", "metric"])
const Model = Schema.Struct({ view: View })
type Model = typeof Model.Type

// The detail panel's own messages; the lab ignores them.
type Message = DetailMessage

const flags = Effect.sync((): Model => ({
	view: new URLSearchParams(window.location.search).get("view") === "metric" ? "metric" : "tiles",
}))

const HINT = 'no metric named "http_request_total" in the query window; did you mean "http_requests_total"?'

const TILES: ReadonlyArray<{ title: string; state: WidgetDataState }> = [
	{
		title: "Request rate (typo in the metric name)",
		state: {
			_tag: "Error",
			title: null,
			message: "No data in this window",
			kind: "empty",
			warnings: [HINT],
		},
	},
	{
		title: "Request rate (empty, no hint)",
		state: { _tag: "Error", title: null, message: "No data in this window", kind: "empty" },
	},
	{
		title: "Requests or a missing series",
		state: {
			_tag: "Ready",
			data: { _tag: "Value", value: 1240 },
			warnings: [
				'no metric named "checkout_total" in the query window; did you mean "checkouts_total"?',
			],
		},
	},
]

const tile = <M>(h: HtmlBuilder<M>, title: string, state: WidgetDataState): Html =>
	h.div(
		[h.Class("h-56")],
		[
			widgetFrame<M>(
				h,
				{
					widgetId: title,
					hasGrip: false,
					title,
					isEdit: false,
					menu: null,
					isMenuOpen: false,
					contentClassName: undefined,
					state,
					loadingSkeleton: chartSkeleton(h, "line"),
					configure: null,
				},
				() => [typography(h, { size: "lg", weight: "semibold", numeric: true }, ["1,240 req/s"])],
			),
		],
	)

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_lab_promql"),
	pinnedNamespace: null,
	timeZone: "UTC",
}

const row = (serviceName: string): MetricRow => ({
	metricName: "http.server.request.duration",
	metricType: "histogram",
	serviceName,
	metricDescription: "Duration of HTTP server requests.",
	metricUnit: "s",
	dataPointCount: 2000,
	firstSeen: "2026-11-14 12:05:00",
	lastSeen: "2026-11-15 12:00:00",
	isMonotonic: false,
})

/** The detail page with its catalog and attribute keys loaded from fixtures. */
const detailModel = (): DetailModel => {
	const step = (model: DetailModel, message: DetailMessage) => detailUpdate(model, message, context).model
	const windowed = step(
		detailInit({ metricName: "http.server.request.duration", search: {} }, context).model,
		DetailMessage.CompletedResolveWindow({
			window: { startTime: "2026-11-14 12:00:00", endTime: "2026-11-15 12:00:00" },
			nowMs: parseWarehouseDateTime("2026-11-15 12:00:00"),
			mode: "Load",
		}),
	)
	const catalogued = step(
		windowed,
		DetailMessage.CompletedFetchCatalog({
			key: windowed.catalog.key ?? "",
			result: Result.succeed([row("checkout"), row("payments")]),
		}),
	)
	return step(
		catalogued,
		DetailMessage.CompletedFetchAttributeKeys({
			key: catalogued.attributeKeys.key ?? "",
			result: Result.succeed([
				{ attributeKey: "http.route", usageCount: 4100 },
				{ attributeKey: "http.response.status_code", usageCount: 4100 },
			]),
		}),
	)
}

const metricView = (h: HtmlBuilder<Message>): Html => {
	const model = detailModel()
	const summary = summaryOf(model)
	return h.div([h.Class("max-w-sm")], summary === null ? [] : [metadataPanel(h, model, summary, "UTC")])
}

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("min-h-screen bg-background p-6")],
		[
			model.view === "metric"
				? metricView(h)
				: h.div(
						[h.Class("grid max-w-5xl grid-cols-3 gap-4")],
						Arr.map(TILES, ({ title, state }) => tile(h, title, state)),
					),
		],
	)

export const lab = defineLabWithFlags("PromQL hints", {
	Model,
	Flags: Model,
	flags,
	init: (input: Model) => ({ model: input }),
	update: (model: Model, _message: Message) => ({ model }),
	view,
})
