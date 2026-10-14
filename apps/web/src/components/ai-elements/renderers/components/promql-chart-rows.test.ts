import { describe, expect, it } from "vitest"
import { promQlChartRows } from "./promql-chart-rows"

describe("promQlChartRows", () => {
	it("merges series into time-ordered buckets keyed by their labels", () => {
		const rows = promQlChartRows([
			{
				labels: { __name__: "x", project_id: "shop-prod", service: "api" },
				points: [
					[1_760_000_060, 2],
					[1_760_000_000, 1],
				],
			},
			{ labels: { project_id: "shop-dev", service: "api" }, points: [[1_760_000_060, 5]] },
		])
		expect(rows).toEqual([
			{
				bucket: "2025-10-09T08:53:20.000Z",
				series: { "__name__=x, project_id=shop-prod, service=api": 1 },
			},
			{
				bucket: "2025-10-09T08:54:20.000Z",
				series: {
					"__name__=x, project_id=shop-prod, service=api": 2,
					"project_id=shop-dev, service=api": 5,
				},
			},
		])
	})

	it("names a label-less series", () => {
		expect(promQlChartRows([{ labels: {}, points: [[0, 3]] }])).toEqual([
			{ bucket: "1970-01-01T00:00:00.000Z", series: { value: 3 } },
		])
	})
})
