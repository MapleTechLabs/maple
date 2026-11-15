import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { dataSourcePromql, dataSourceQuerySet, dataSourceRawSql, dataSourceRouteParams } from "./access"
import { makePromqlDataSource } from "./construct"
import { redactForShare } from "./redact"
import { toWidgetRequest } from "./request"
import { WidgetDataSourceV3 } from "./v3/data-source"

const decode = Schema.decodeUnknownSync(WidgetDataSourceV3)

const full = {
	query: 'sum by (job) (rate(http_requests_total{job=~"$service"}[$__rate_interval]))',
	legendFormat: "{{job}}",
	minStepSeconds: 30,
	displayType: "line",
}

describe("makePromqlDataSource", () => {
	it("decodes as the v3 promql arm and reads back unchanged", () => {
		const source = decode(makePromqlDataSource(full))
		expect(source.kind).toBe("promql")
		expect(dataSourcePromql(source)).toEqual(full)
	})

	it("writes no keys for unset options", () => {
		expect(makePromqlDataSource({ query: "up" })).toEqual({ kind: "promql", query: "up" })
	})

	it("is not a query set, raw SQL or route", () => {
		const source = makePromqlDataSource({ query: "up" })
		expect(dataSourceQuerySet(source)).toBeNull()
		expect(dataSourceRawSql(source)).toBeNull()
		expect(dataSourceRouteParams(source)).toBeUndefined()
	})

	it("refuses a promql source with no query", () => {
		expect(() => decode({ kind: "promql" })).toThrow()
	})
})

describe("a promql source lowered for the fetch layer", () => {
	it("names the promql endpoint and puts the query under `promql`", () => {
		expect(toWidgetRequest(makePromqlDataSource(full))).toEqual({
			endpoint: "promql_chart",
			params: {
				promql: full.query,
				legendFormat: "{{job}}",
				minStepSeconds: 30,
				displayType: "line",
			},
		})
	})
})

describe("a shared promql widget", () => {
	it("keeps the kind and drops the query", () => {
		const shared = redactForShare({
			id: "d",
			name: "Board",
			timeRange: { type: "relative", value: "1h" },
			widgets: [
				{
					id: "w",
					visualization: "chart",
					display: { title: "Rate" },
					layout: { x: 0, y: 0, w: 6, h: 4 },
					dataSource: makePromqlDataSource(full),
				},
			],
		})
		expect(shared?.widgets[0]?.dataSource).toEqual({ kind: "promql" })
	})
})
