import { Array as Arr } from "effect"
import { describe, expect, test } from "vitest"
import { labBreakdown, labTimeseries, labTotals } from "./cost-fixture"

const window = { days: 30, filters: undefined }
const openRouterOnly = { days: 30, filters: { provider: ["openrouter"] } }

describe("cost lab fixture", () => {
	test("a removed OpenRouter source leaves every read, also under a filter naming it", () => {
		const before = labTotals(window).cost
		const after = labTotals({ ...window, withoutOpenRouter: true }).cost
		expect(after).toBeGreaterThan(0)
		expect(after).toBeLessThan(before)
		expect(
			Arr.map(
				labBreakdown({ ...window, withoutOpenRouter: true, groupBy: "provider", sortBy: "cost" })
					.rows,
				(row) => row.key,
			),
		).toEqual(["aws"])

		// Filtered to OpenRouter there is nothing left: AWS cost must not show under that filter.
		expect(labTotals(openRouterOnly).cost).toBeGreaterThan(0)
		expect(labTotals({ ...openRouterOnly, withoutOpenRouter: true }).cost).toBe(0)
		expect(
			labBreakdown({
				...openRouterOnly,
				withoutOpenRouter: true,
				groupBy: "cloud_service",
				sortBy: "cost",
			}).rows,
		).toEqual([])
		expect(
			labTimeseries({ ...openRouterOnly, withoutOpenRouter: true, groupBy: "provider", limit: 8 })
				.series,
		).toEqual([])
	})
})
