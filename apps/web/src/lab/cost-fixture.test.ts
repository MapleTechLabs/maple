import { Array as Arr } from "effect"
import { describe, expect, test } from "vitest"
import { labBreakdown, labTimeseries, labTotals } from "./cost-fixture"

const window = { days: 30, filters: undefined }
const openRouterOnly = { days: 30, filters: { provider: ["openrouter"] } }

describe("cost lab fixture", () => {
	test("a removed OpenRouter source leaves every read, also under a filter naming it", () => {
		const before = labTotals(window).cost
		const after = labTotals({ ...window, without: ["openrouter"] }).cost
		expect(after).toBeGreaterThan(0)
		expect(after).toBeLessThan(before)
		expect(
			Arr.map(
				labBreakdown({ ...window, without: ["openrouter"], groupBy: "provider", sortBy: "cost" })
					.rows,
				(row) => row.key,
			),
		).toEqual(["aws", "vercel"])

		// Filtered to OpenRouter there is nothing left: AWS cost must not show under that filter.
		expect(labTotals(openRouterOnly).cost).toBeGreaterThan(0)
		expect(labTotals({ ...openRouterOnly, without: ["openrouter"] }).cost).toBe(0)
		expect(
			labBreakdown({
				...openRouterOnly,
				without: ["openrouter"],
				groupBy: "cloud_service",
				sortBy: "cost",
			}).rows,
		).toEqual([])
		expect(
			labTimeseries({ ...openRouterOnly, without: ["openrouter"], groupBy: "provider", limit: 8 })
				.series,
		).toEqual([])
	})

	test("a removed Vercel source leaves every read too, and the other providers stay", () => {
		const removed = { ...window, without: ["vercel"] }
		expect(labTotals(removed).cost).toBeLessThan(labTotals(window).cost)
		expect(
			Arr.map(labBreakdown({ ...removed, groupBy: "provider", sortBy: "cost" }).rows, (row) => row.key),
		).toEqual(["aws", "openrouter"])
		expect(labTotals({ days: 30, filters: { provider: ["vercel"] }, without: ["vercel"] }).cost).toBe(0)
	})

	test("grouped by resource, a Vercel team's cost splits by project and the rest has none", () => {
		expect(
			Arr.map(labBreakdown({ ...window, groupBy: "resource", sortBy: "cost" }).rows, (row) => row.key),
		).toEqual(["", "example-web", "example-docs"])
	})
})
