import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { makePromQlDataSource } from "./construct"
import { redactForShare } from "./redact"
import { toWidgetRequest } from "./request"
import { WidgetDataSourceV3 } from "./v3/data-source"

const QUERY =
	'sum by (service) (rate({"run.googleapis.com/request_count", monitored_resource="cloud_run_revision"}[5m]))'

describe("a Google Cloud PromQL data source", () => {
	it("survives a decode/encode round trip with every field", () => {
		const source = makePromQlDataSource({
			query: QUERY,
			projects: ["shop-prod", "shop-staging"],
			legend: "{{service}}",
			transform: { reduceToValue: { field: "value", aggregate: "avg" } },
		})
		const decoded = Schema.decodeUnknownSync(WidgetDataSourceV3)(source)

		expect(Schema.encodeUnknownSync(WidgetDataSourceV3)(decoded)).toEqual(source)
	})

	it("lowers to the live PromQL endpoint with only the fields it has", () => {
		expect(toWidgetRequest(makePromQlDataSource({ query: QUERY }))).toEqual({
			endpoint: "gcp_promql",
			params: { promql: QUERY },
		})
		expect(
			toWidgetRequest(
				makePromQlDataSource({ query: QUERY, projects: ["shop-prod"], legend: "{{service}}" }),
			),
		).toEqual({
			endpoint: "gcp_promql",
			params: { promql: QUERY, projects: ["shop-prod"], legend: "{{service}}" },
		})
	})

	it("reaches a share link without its query, projects or legend", () => {
		const redacted = redactForShare({
			id: "dash-1",
			name: "Cloud Run",
			timeRange: { type: "relative", value: "1h" },
			widgets: [
				{
					id: "w-promql",
					visualization: "chart",
					display: { title: "Requests" },
					layout: { x: 0, y: 0, w: 6, h: 4 },
					dataSource: makePromQlDataSource({
						query: QUERY,
						projects: ["shop-prod"],
						legend: "{{service}}",
						transform: { limit: 5 },
					}),
				},
			],
		})

		expect(redacted?.widgets[0]?.dataSource).toEqual({ kind: "promql", transform: { limit: 5 } })
		expect(JSON.stringify(redacted)).not.toContain("shop-prod")
	})
})
