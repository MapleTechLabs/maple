import { DashboardDocument } from "@maple/domain/http"
import { dataSourceTransform, makeRouteDataSource } from "@maple/widgets/dashboard"
import { Schema, Array as Arr } from "effect"
import { describe, expect, test } from "vitest"
import { setPanelType } from "./edits"
import {
	buildDataSource,
	buildDisplay,
	buildSqlDisplay,
	builderDataSourceOf,
	queryCapabilitiesOf,
	statValueFieldOf,
	toInitialState,
	trackStoredSource,
	validationErrorOf,
	type Widget,
} from "./lowering"
import { rawSqlDataSourceOf } from "./raw-sql"

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
		expect(buildDisplay(widget, { ...state, gaugeMin: "", gaugeMax: "500" }).gauge).toEqual({
			min: 0,
			max: 500,
		})
	})

	test("a breakdown type without a group-by blocks Apply", () => {
		const state = toInitialState(widgetOf("pie", { title: "Share" }))
		const ungrouped = {
			...state,
			queries: Arr.map(state.queries, (query) => ({ ...query, groupBy: [] })),
		}
		expect(validationErrorOf(ungrouped)).toMatch(/group-by/)
	})

	test("a fixed-endpoint stat keeps its stored source until its stand-in queries are edited", () => {
		const widget = widgetOf("stat", { title: "Total Traces", unit: "number" })
		const state = toInitialState(widget)
		const retitled = trackStoredSource(state, { ...state, title: "All traces" })
		expect(builderDataSourceOf(widget, retitled)).toEqual(widget.dataSource)
		const averaged = trackStoredSource(state, { ...state, statAggregate: "avg" })
		expect(dataSourceTransform(builderDataSourceOf(widget, averaged))?.reduceToValue).toEqual({
			field: "totalTraces",
			aggregate: "avg",
		})
		const requeried = trackStoredSource(state, {
			...state,
			queries: Arr.map(state.queries, (query) => ({ ...query, whereClause: 'service.name = "api"' })),
		})
		expect(builderDataSourceOf(widget, requeried)).toMatchObject({ kind: "query" })
		// Editing back to what was opened keeps the stored source.
		expect(
			builderDataSourceOf(widget, trackStoredSource(state, { ...requeried, queries: state.queries })),
		).toEqual(widget.dataSource)
		expect(
			builderDataSourceOf(widget, trackStoredSource(state, setPanelType(state, "line"))),
		).toMatchObject({
			kind: "query",
		})
	})

	test("a Raw SQL source rebuilds its reduction from the picked type and the stat settings", () => {
		const widget = widgetOf("stat", { title: "Total" })
		const sql = {
			sql: "SELECT count() AS total FROM traces WHERE $__orgFilter",
			granularitySeconds: null,
		}
		const stat = {
			visualization: "stat" as const,
			chartId: "",
			statAggregate: "max" as const,
			statValueField: "total",
		}
		expect(dataSourceTransform(rawSqlDataSourceOf(widget, sql, stat))?.reduceToValue).toEqual({
			field: "total",
			aggregate: "max",
		})
		expect(
			dataSourceTransform(rawSqlDataSourceOf(widget, sql, { ...stat, statValueField: "" }))
				?.reduceToValue,
		).toEqual({ field: "value", aggregate: "max" })
		const line = { ...stat, visualization: "chart" as const, chartId: "query-builder-line" }
		expect(dataSourceTransform(rawSqlDataSourceOf(widget, sql, line))?.reduceToValue).toBeUndefined()
	})

	test("an endpoint widget switched to Raw SQL carries none of its old transform", () => {
		const widget = {
			...widgetOf("chart", {}),
			dataSource: makeRouteDataSource("service_usage", undefined, {
				fieldMap: { total: "totalTraces" },
				hideSeries: { baseNames: ["errors"] },
			}),
		}
		const sql = { sql: "SELECT 1 AS value FROM traces WHERE $__orgFilter", granularitySeconds: null }
		const line = {
			visualization: "chart" as const,
			chartId: "query-builder-line",
			statAggregate: "first" as const,
			statValueField: "",
		}
		expect(dataSourceTransform(rawSqlDataSourceOf(widget, sql, line))).toBeUndefined()
	})

	test("a Raw SQL stat writes no builder sparkline and no title derived from builder queries", () => {
		const widget = widgetOf("stat", {})
		const state = {
			...toInitialState(widget),
			title: "",
			sparklineEnabled: true,
			keepsStoredSource: false,
		}
		expect(buildDisplay(widget, state).sparkline?.enabled).toBe(true)
		const sqlDisplay = buildSqlDisplay(widget, state)
		expect(sqlDisplay.sparkline).toBeUndefined()
		expect(sqlDisplay.title).toBeUndefined()
	})

	test("a preset stat keeps its stored sparkline source, never one built from its stand-in queries", () => {
		const trend = makeRouteDataSource("service_usage_timeseries", undefined, undefined)
		const widget = widgetOf("stat", { sparkline: { enabled: true, dataSource: trend } })
		const state = { ...toInitialState(widget), title: "Renamed" }
		expect(state.keepsStoredSource).toBe(true)
		expect(buildDisplay(widget, state).sparkline).toEqual({ enabled: true, dataSource: trend })
		const bare = widgetOf("stat", {})
		const enabled = { ...toInitialState(bare), sparklineEnabled: true }
		expect(buildDisplay(bare, enabled).sparkline).toBeUndefined()
	})

	test("comparison and formulas are offered only where the lowered source keeps them", () => {
		const state = toInitialState(widgetOf("stat", { title: "Total" }))
		expect(queryCapabilitiesOf(state)).toEqual({ comparison: true, formulas: true })
		expect(queryCapabilitiesOf(setPanelType(state, "line"))).toEqual({ comparison: true, formulas: true })
		expect(queryCapabilitiesOf(setPanelType(state, "pie"))).toEqual({
			comparison: false,
			formulas: false,
		})
		expect(queryCapabilitiesOf(setPanelType(state, "histogram"))).toEqual({
			comparison: false,
			formulas: false,
		})
		const grouped = Arr.map(state.queries, (query) => ({
			...query,
			addOns: { ...query.addOns, groupBy: true },
			groupBy: ["service.name"],
		}))
		expect(queryCapabilitiesOf({ ...setPanelType(state, "table"), queries: grouped }).formulas).toBe(
			false,
		)
	})

	test("a stat reduces an enabled series: a disabled or removed pick falls back to the first", () => {
		const state = toInitialState(widgetOf("stat", { title: "Total" }))
		const [first] = state.queries
		if (first === undefined) return expect.unreachable("the stand-in has query A")
		const second = { ...first, id: "b", name: "B" }
		const disabledFirst = {
			...state,
			queries: [{ ...first, enabled: false }, second],
			statValueField: "A",
		}
		expect(statValueFieldOf(disabledFirst)).toBe("B")
		const stale = { ...state, statValueField: "C" }
		expect(dataSourceTransform(buildDataSource(stale))?.reduceToValue?.field).toBe("A")
	})
})
