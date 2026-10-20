import { DashboardDocument } from "@maple/domain/http"
import { dataSourceTransform, makeRouteDataSource } from "@maple/widgets/dashboard"
import { Schema } from "effect"
import { describe, expect, test } from "vitest"
import { buildDataSource, buildDisplay, toInitialState, validationErrorOf, type Widget } from "./lowering"

const widgetOf = (visualization: string, display: Readonly<Record<string, unknown>>): Widget => {
	const document = Schema.decodeUnknownSync(DashboardDocument)({
		id: "dash",
		name: "Board",
		timeRange: { type: "relative", value: "6h" },
		widgets: [
			{
				id: "w",
				visualization,
				dataSource: makeRouteDataSource("service_usage", undefined, {
					reduceToValue: { field: "totalTraces", aggregate: "sum" },
				}),
				display,
				layout: { x: 0, y: 0, w: 3, h: 4 },
			},
		],
		createdAt: "2026-09-19T12:00:00.000Z",
		updatedAt: "2026-09-28T12:00:00.000Z",
		schemaVersion: 3,
	})
	return document.widgets[0] ?? expect.unreachable("the fixture board has one widget")
}

describe("widget editor lowering", () => {
	test("a route stat opens as query A with its reduction, and applies as a query-set reduction", () => {
		const widget = widgetOf("stat", { title: "Total", unit: "number" })
		const state = toInitialState(widget)
		expect(state.queries).toHaveLength(1)
		expect(state.statAggregate).toBe("sum")
		const reduced = dataSourceTransform(buildDataSource({ ...state, statValueField: "" }))?.reduceToValue
		expect(reduced).toEqual({ field: "A", aggregate: "sum" })
	})

	test("a gauge writes its range, defaulting unparsable bounds to 0 and 100", () => {
		const widget = widgetOf("gauge", { title: "Budget", gauge: { min: 10, max: 20 } })
		const state = toInitialState(widget)
		expect([state.gaugeMin, state.gaugeMax]).toEqual(["10", "20"])
		expect(buildDisplay(widget, { ...state, gaugeMin: "", gaugeMax: "500" }).gauge).toEqual({ min: 0, max: 500 })
	})

	test("a breakdown type without a group-by blocks Apply", () => {
		const state = toInitialState(widgetOf("pie", { title: "Share" }))
		const ungrouped = { ...state, queries: state.queries.map((query) => ({ ...query, groupBy: [] })) }
		expect(validationErrorOf(ungrouped)).toMatch(/group-by/)
	})
})
