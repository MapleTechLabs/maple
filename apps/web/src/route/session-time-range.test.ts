import { Option } from "effect"
import { describe, expect, test } from "vitest"
import { AppRoute } from "./app-route"
import { completeRangeOf, withSessionRange } from "./session-time-range"

const NOW = Date.UTC(2026, 9, 1, 12)
const traces = AppRoute.Traces({ search: {} })

describe("session time range", () => {
	test("a navigation that names no window lands on the remembered one", () => {
		expect(withSessionRange(traces, "/traces", { timePreset: "1d" }, NOW, "UTC")).toEqual(
			Option.some("/traces?timePreset=1d"),
		)
	})

	test("a navigation that names a window keeps it", () => {
		const named = AppRoute.Traces({ search: { timePreset: "6h" } })
		expect(withSessionRange(named, "/traces?timePreset=6h", { timePreset: "1d" }, NOW, "UTC")).toEqual(
			Option.none(),
		)
	})

	test("a window wider than the page's ceiling is ignored there, but not on Services", () => {
		const year = { timePreset: "90d" }
		expect(withSessionRange(traces, "/traces", year, NOW, "UTC")).toEqual(Option.none())
		const services = AppRoute.Services({ search: {} })
		expect(withSessionRange(services, "/services", year, NOW, "UTC")).toEqual(
			Option.some("/services?timePreset=90d"),
		)
	})

	test("a page without the middleware is left alone", () => {
		const dashboards = AppRoute.Dashboards({ search: {} })
		expect(withSessionRange(dashboards, "/dashboards", { timePreset: "1d" }, NOW, "UTC")).toEqual(
			Option.none(),
		)
	})

	test("only a preset or both bounds are remembered", () => {
		expect(completeRangeOf(AppRoute.Traces({ search: { startTime: "2026-10-01 00:00:00" } }))).toEqual(
			Option.none(),
		)
		expect(completeRangeOf(AppRoute.Traces({ search: { timePreset: "1d" } }))).toEqual(
			Option.some({ timePreset: "1d" }),
		)
	})
})
