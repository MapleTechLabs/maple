import { DashboardDocument } from "@maple/domain/http"
import { Array as Arr, Option, Schema } from "effect"
import { Submodel } from "foldkit"
import { expect, given, Mount, scene, text, withViewInputs } from "foldkit/scene"
import { describe, test } from "vitest"
import * as Chart from "@maple/views/charts/chart"
import { MeasureChartContainer, MountChart } from "@maple/views/charts/chart-mounts"
import { type TileContext, widgetTile } from "./tiles"

// A Requests/sec chart reads per second whichever source fills it.

type Model = Readonly<{ source: "promql" | "query" }>
type Message = "Ignored"

const display = {
	title: "Requests",
	chartId: "query-builder-line",
	unit: "requests_per_sec",
	chartPresentation: { legend: "visible", seriesStats: true },
} as const

const widgets = Schema.decodeSync(DashboardDocument)({
	id: "dash_rates",
	name: "Rates",
	timeRange: { type: "relative", value: "1h" },
	widgets: [
		{
			id: "promql",
			visualization: "chart",
			dataSource: {
				kind: "promql",
				query: "sum by (job) (rate(http_server_request_duration_seconds_count[5m]))",
			},
			display,
			layout: { x: 0, y: 0, w: 6, h: 4 },
		},
		{
			id: "query",
			visualization: "chart",
			dataSource: { kind: "route", endpoint: "service_overview" },
			display,
			layout: { x: 6, y: 0, w: 6, h: 4 },
		},
	],
	createdAt: "2026-09-19T12:00:00.000Z",
	updatedAt: "2026-09-28T12:00:00.000Z",
	schemaVersion: 3,
}).widgets

// One-minute buckets: PromQL answers 1.27/s, the query builder 76.2 requests per bucket (1.27/s).
const rowsOf = (value: number) => [
	{ bucket: "2026-10-01 12:00:00", api: value },
	{ bucket: "2026-10-01 12:01:00", api: value },
	{ bucket: "2026-10-01 12:02:00", api: value },
]

const tile = withViewInputs(
	Submodel.defineView<Model, Message, Record<string, never>>((model, _inputs, h) => {
		const widget = Arr.findFirst(widgets, (entry) => entry.id === model.source)
		const ctx: TileContext<Message> = {
			h,
			state: {
				_tag: "Ready",
				data: { _tag: "Rows", rows: rowsOf(model.source === "promql" ? 1.27 : 76.2) },
			},
			isEdit: false,
			menu: null,
			isMenuOpen: false,
			hasGrip: false,
			configure: null,
			chart: Chart.init(),
			themeColors: {},
			chartRuntime: { _tag: "Ready" },
			nowMs: Date.parse("2026-10-01T12:30:00Z"),
			timeZone: "UTC",
			tableSort: { key: null, dir: "desc" },
			onChart: () => "Ignored",
			onSort: () => "Ignored",
			reloadPage: null,
		}
		return Option.match(widget, { onNone: () => h.empty, onSome: (found) => widgetTile(h, ctx, found) })
	}),
	{},
)()

const config = { update: (model: Model) => ({ model }), view: tile }
const mounts = Mount.resolveAll([MeasureChartContainer, "Ignored"], [MountChart, "Ignored"])

describe("a Requests/sec chart tile", () => {
	test("shows a PromQL rate as it came, not divided by the bucket again", () => {
		scene(config, given({ source: "promql" }), mounts, expect(text("1.27/s")).toExist())
	})

	test("shows a query-builder rate per second", () => {
		scene(config, given({ source: "query" }), mounts, expect(text("1.27/s")).toExist())
	})
})
