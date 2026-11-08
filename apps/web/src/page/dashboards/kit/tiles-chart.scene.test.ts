import { DashboardDocument } from "@maple/domain/http"
import { Schema } from "effect"
import { Submodel } from "foldkit"
import { click, expect, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, test } from "vitest"
import * as Chart from "@maple/views/charts/chart"
import type { ChartRuntime } from "@maple/views/charts/chart-runtime"
import { type TileContext, widgetTile } from "./tiles"

// A chart tile when the chart code itself could not load.

type Model = Readonly<{ runtime: ChartRuntime; reloads: number; dataLoading?: boolean; noRows?: boolean }>
type Message = "ClickedReloadPage" | "Ignored"

const [widget] = Schema.decodeSync(DashboardDocument)({
	id: "dash_runtime",
	name: "Runtime",
	timeRange: { type: "relative", value: "1h" },
	widgets: [
		{
			id: "throughput",
			visualization: "chart",
			dataSource: { kind: "route", endpoint: "service_overview" },
			display: { title: "Throughput", chartId: "query-builder-line" },
			layout: { x: 0, y: 0, w: 6, h: 4 },
		},
	],
	createdAt: "2026-09-19T12:00:00.000Z",
	updatedAt: "2026-09-28T12:00:00.000Z",
	schemaVersion: 3,
}).widgets

const tile = withViewInputs(
	Submodel.defineView<Model, Message, Record<string, never>>((model, _inputs, h) => {
		const ctx: TileContext<Message> = {
			h,
			state:
				model.dataLoading === true
					? { _tag: "Loading" }
					: {
							_tag: "Ready",
							data: {
								_tag: "Rows",
								rows:
									model.noRows === true
										? []
										: [{ bucket: "2026-10-01 12:00:00", value: 3 }],
							},
						},
			isEdit: false,
			menu: null,
			isMenuOpen: false,
			hasGrip: false,
			configure: null,
			chart: Chart.init(),
			themeColors: {},
			chartRuntime: model.runtime,
			nowMs: Date.parse("2026-10-01T12:30:00Z"),
			timeZone: "UTC",
			tableSort: { key: null, dir: "desc" },
			onChart: () => "Ignored",
			onSort: () => "Ignored",
			reloadPage: "ClickedReloadPage",
		}
		return h.div(
			[],
			[
				widget === undefined ? h.empty : widgetTile(h, ctx, widget),
				h.span([], [`reloads ${model.reloads}`]),
			],
		)
	}),
	{},
)()

const config = {
	update: (model: Model, message: Message) => ({
		model: message === "ClickedReloadPage" ? { ...model, reloads: model.reloads + 1 } : model,
	}),
	view: tile,
}

describe("a chart tile whose chart code failed to load", () => {
	test("says so and offers a page reload instead of a skeleton that never resolves", () => {
		scene(
			config,
			given({ runtime: { _tag: "Failed", reason: "chunk 404" }, reloads: 0 }),
			expect(text("Charts couldn't load")).toExist(),
			click(role("button", { name: "Reload page" })),
			expect(text("reloads 1")).toExist(),
		)
	})

	test("says so while the tile's data is still loading", () => {
		scene(
			config,
			given({ runtime: { _tag: "Failed", reason: "chunk 404" }, reloads: 0, dataLoading: true }),
			expect(text("Charts couldn't load")).toExist(),
			expect(role("button", { name: "Reload page" })).toExist(),
		)
	})

	test("says so even when the query returned no rows", () => {
		scene(
			config,
			given({ runtime: { _tag: "Failed", reason: "chunk 404" }, reloads: 0, noRows: true }),
			expect(text("Charts couldn't load")).toExist(),
			expect(text("No data in this window")).toBeAbsent(),
		)
	})

	test("still loading shows no error", () => {
		scene(
			config,
			given({ runtime: { _tag: "Loading" }, reloads: 0 }),
			expect(text("Charts couldn't load")).toBeAbsent(),
		)
	})
})
