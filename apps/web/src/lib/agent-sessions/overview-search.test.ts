import { describe, expect, it } from "vitest"

import {
	activeOverviewFilters,
	clearOverviewFilters,
	compareEnabled,
	failingOnly,
	overviewApiDimension,
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
