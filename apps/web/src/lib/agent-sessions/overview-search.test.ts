import { describe, expect, it } from "vitest"

import {
	OVERVIEW_DIMENSIONS,
	activeOverviewFilters,
	clearOverviewFilters,
	compareEnabled,
	failingOnly,
	overviewApiDimension,
	overviewFilterPatch,
	overviewWindowLabel,
	sessionsLinkSearch,
	toggleOverviewFilter,
	type AgentOverviewSearch,
} from "./overview-search"

describe("overviewApiDimension", () => {
	it("renames the page's framework to the warehouse's vendor and leaves the rest", () => {
		expect(overviewApiDimension("framework")).toBe("vendor")
		expect(overviewApiDimension("model")).toBe("model")
		expect(overviewApiDimension("tool")).toBe("tool")
	})
})

describe("compareEnabled", () => {
	it("is on when the URL says nothing, and only `false` turns it off", () => {
		expect(compareEnabled({})).toBe(true)
		expect(compareEnabled({ compare: true })).toBe(true)
		expect(compareEnabled({ compare: false })).toBe(false)
	})
})

describe("failingOnly", () => {
	it("reads only an explicit true", () => {
		expect(failingOnly({})).toBe(false)
		expect(failingOnly({ hasErrors: false })).toBe(false)
		expect(failingOnly({ hasErrors: true })).toBe(true)
	})
})

describe("activeOverviewFilters", () => {
	it("lists the set dimensions in the dimensions' own order", () => {
		const search: AgentOverviewSearch = { tool: "run_tests", model: "opus", environment: "prd" }
		expect(activeOverviewFilters(search)).toEqual([
			{ dimension: "model", value: "opus" },
			{ dimension: "environment", value: "prd" },
			{ dimension: "tool", value: "run_tests" },
		])
	})

	it("is empty when only the toggles are set", () => {
		expect(activeOverviewFilters({ hasErrors: true, compare: false })).toEqual([])
	})
})

describe("clearOverviewFilters", () => {
	it("clears every dimension and leaves the toggles alone", () => {
		const patch = clearOverviewFilters()
		expect(patch).toEqual({
			model: undefined,
			agent: undefined,
			service: undefined,
			framework: undefined,
			environment: undefined,
			tool: undefined,
		})
		expect("hasErrors" in patch).toBe(false)
		expect("compare" in patch).toBe(false)
	})
})

describe("toggleOverviewFilter", () => {
	it("selects a key that is not the current one", () => {
		expect(toggleOverviewFilter({}, "model", "opus")).toEqual({ model: "opus" })
	})

	it("clears the dimension when the key is already selected", () => {
		expect(toggleOverviewFilter({ model: "opus" }, "model", "opus")).toEqual({ model: undefined })
	})

	it("clears rather than selects the unattributed key, which has no spelling", () => {
		expect(toggleOverviewFilter({ agent: "a" }, "agent", "")).toEqual({ agent: undefined })
	})
})

describe("overviewFilterPatch", () => {
	// Written out rather than built from a computed key, so every dimension has
	// to be covered by hand — a missing arm is a control that silently does
	// nothing.
	it("sets exactly its own dimension, for all six", () => {
		expect(overviewFilterPatch("model", "claude-opus-5")).toEqual({ model: "claude-opus-5" })
		expect(overviewFilterPatch("agent", "captain")).toEqual({ agent: "captain" })
		expect(overviewFilterPatch("service", "api")).toEqual({ service: "api" })
		expect(overviewFilterPatch("framework", "eve")).toEqual({ framework: "eve" })
		expect(overviewFilterPatch("environment", "prd")).toEqual({ environment: "prd" })
		expect(overviewFilterPatch("tool", "run_tests")).toEqual({ tool: "run_tests" })
	})

	it("clears its own dimension and no other", () => {
		for (const dimension of OVERVIEW_DIMENSIONS) {
			expect(overviewFilterPatch(dimension, undefined)).toEqual({ [dimension]: undefined })
		}
	})
})

describe("sessionsLinkSearch", () => {
	it("widens each single value into the list's array-valued key", () => {
		expect(
			sessionsLinkSearch({
				framework: "eve",
				model: "opus",
				agent: "captain",
				service: "api",
				environment: "prd",
				tool: "run_tests",
			}),
		).toEqual({
			vendors: ["eve"],
			services: ["api"],
			environments: ["prd"],
			models: ["opus"],
			agents: ["captain"],
			tools: ["run_tests"],
			hasErrors: undefined,
		})
	})

	it("carries the board's failing-only toggle", () => {
		expect(sessionsLinkSearch({ hasErrors: true }).hasErrors).toBe(true)
	})

	it("lets the errored tab ask for failures the board is not filtered to", () => {
		expect(sessionsLinkSearch({}, { hasErrors: true }).hasErrors).toBe(true)
	})
})

describe("overviewWindowLabel", () => {
	const hours = (count: number) => count * 3_600_000
	/** An absolute range in the URL, which is what makes the default irrelevant. */
	const ABSOLUTE = { startTime: "2026-09-10 00:00:00", endTime: "2026-09-10 03:00:00" }

	it("lets a preset name itself", () => {
		expect(overviewWindowLabel({ timePreset: "24h" }, hours(24))).toBe("24h")
	})

	it("falls back to the page's default only while the URL carries no window", () => {
		expect(overviewWindowLabel({}, hours(3))).toBe("7d")
		// Half a range is not a range: the resolver would still use the default.
		expect(overviewWindowLabel({ startTime: ABSOLUTE.startTime }, hours(3))).toBe("7d")
	})

	it("names an absolute range after its own length, not after the default", () => {
		expect(overviewWindowLabel(ABSOLUTE, hours(3))).toBe("3h")
		expect(overviewWindowLabel(ABSOLUTE, hours(24))).toBe("24h")
		expect(overviewWindowLabel(ABSOLUTE, hours(72))).toBe("3d")
		expect(overviewWindowLabel(ABSOLUTE, 45 * 60_000)).toBe("45m")
	})
})
