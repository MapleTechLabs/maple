import { describe, expect, it } from "vitest"
import {
	agentSessionsFilterInputs,
	agentSessionsSortPatch,
	hasAgentSessionsFilters,
} from "./agent-sessions-filter-inputs"

const window = { startTime: "2026-08-19 09:00:00", endTime: "2026-08-19 11:00:00" }

describe("agentSessionsFilterInputs", () => {
	it("sends only the window when nothing is set", () => {
		expect(agentSessionsFilterInputs({}, window)).toEqual(window)
	})

	it("renames the URL keys and converts seconds to milliseconds", () => {
		expect(
			agentSessionsFilterInputs(
				{
					vendors: ["eve"],
					services: [],
					models: ["gpt-5.5"],
					q: "  wrun_01 ",
					hasErrors: true,
					grouped: true,
					durationMin: 30,
					durationMax: 600,
					costMin: 0.1,
					tokensMax: 200_000,
					llmCallsMin: 1,
					toolCallsMax: 9,
					sortBy: "cost",
					sortDir: "desc",
				},
				window,
			),
		).toEqual({
			...window,
			vendorIds: ["eve"],
			models: ["gpt-5.5"],
			search: "wrun_01",
			hasErrors: true,
			excludeTraceSessions: true,
			durationMinMs: 30_000,
			durationMaxMs: 600_000,
			costMin: 0.1,
			tokensMax: 200_000,
			llmCallsMin: 1,
			toolCallsMax: 9,
			sortBy: "cost",
			sortDir: "desc",
		})
	})

	it("sends a sort only when it is not the default, filling in the half the URL leaves off", () => {
		expect(agentSessionsFilterInputs({ sortBy: "startTime", sortDir: "desc" }, window)).toEqual(window)
		expect(agentSessionsFilterInputs({ sortBy: "cost", sortDir: "asc" }, window)).toEqual({
			...window,
			sortBy: "cost",
			sortDir: "asc",
		})
		expect(agentSessionsFilterInputs({ sortBy: "cost" }, window)).toEqual({
			...window,
			sortBy: "cost",
			sortDir: "desc",
		})
		expect(agentSessionsFilterInputs({ sortDir: "asc" }, window)).toEqual({
			...window,
			sortBy: "startTime",
			sortDir: "asc",
		})
	})

	it("treats false toggles, empty arrays and blank search as no filter", () => {
		expect(hasAgentSessionsFilters({})).toBe(false)
		expect(hasAgentSessionsFilters({ hasErrors: false, services: [], sortBy: "cost" })).toBe(false)
		expect(hasAgentSessionsFilters({ q: "a" })).toBe(true)
		expect(hasAgentSessionsFilters({ durationMin: 0 })).toBe(true)
		const inputs = agentSessionsFilterInputs({ hasErrors: false, grouped: false, q: "  " }, window)
		expect(inputs).toEqual(window)
	})
})

describe("agentSessionsSortPatch", () => {
	it("starts a newly sorted column descending", () => {
		expect(agentSessionsSortPatch({}, "cost")).toEqual({ sortBy: "cost", sortDir: "desc" })
		expect(agentSessionsSortPatch({ sortBy: "cost", sortDir: "asc" }, "toolCalls")).toEqual({
			sortBy: "toolCalls",
			sortDir: "desc",
		})
	})

	it("flips the column the list is already sorted by", () => {
		expect(agentSessionsSortPatch({ sortBy: "cost", sortDir: "desc" }, "cost")).toEqual({
			sortBy: "cost",
			sortDir: "asc",
		})
		expect(agentSessionsSortPatch({ sortBy: "cost", sortDir: "asc" }, "cost")).toEqual({
			sortBy: "cost",
			sortDir: "desc",
		})
	})

	// The default order leaves the URL clean, so a shared link only carries a
	// sort when one was chosen.
	it("clears both params when a click lands back on newest first", () => {
		expect(agentSessionsSortPatch({}, "startTime")).toEqual({ sortBy: "startTime", sortDir: "asc" })
		const patch = agentSessionsSortPatch({ sortBy: "startTime", sortDir: "asc" }, "startTime")
		expect(patch).toStrictEqual({ sortBy: undefined, sortDir: undefined })
	})
})
