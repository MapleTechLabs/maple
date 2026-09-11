import { describe, expect, it } from "vitest"

import { overviewSelection, overviewSessionsInput } from "./use-agent-overview"

const WINDOW = { startTime: "2026-09-04 00:00:00", endTime: "2026-09-11 00:00:00" }

describe("overviewSelection", () => {
	it("sends the window and nothing else for an untouched page", () => {
		expect(overviewSelection({}, WINDOW)).toEqual({
			...WINDOW,
			framework: undefined,
			model: undefined,
			agent: undefined,
			service: undefined,
			environment: undefined,
			tool: undefined,
			hasErrors: undefined,
		})
	})

	it("puts every dimension filter in the selection, so each is in the cache key", () => {
		const selection = overviewSelection(
			{
				framework: "eve",
				model: "claude-opus-5",
				agent: "release-captain",
				service: "api",
				environment: "production",
				tool: "run_tests",
			},
			WINDOW,
		)
		expect(selection.framework).toBe("eve")
		expect(selection.model).toBe("claude-opus-5")
		expect(selection.agent).toBe("release-captain")
		expect(selection.service).toBe("api")
		expect(selection.environment).toBe("production")
		expect(selection.tool).toBe("run_tests")
	})

	it("drops an explicitly false failing-only rather than sending it", () => {
		expect(overviewSelection({ hasErrors: false }, WINDOW).hasErrors).toBeUndefined()
		expect(overviewSelection({ hasErrors: true }, WINDOW).hasErrors).toBe(true)
	})

	it("leaves the comparison out — it is a client-side reading of one read", () => {
		expect(overviewSelection({ compare: false }, WINDOW)).toEqual(overviewSelection({}, WINDOW))
	})
})

describe("overviewSessionsInput", () => {
	it("widens each single value into the list endpoint's array key", () => {
		const input = overviewSessionsInput({ model: "claude-opus-5", framework: "eve" }, WINDOW, {
			sortBy: "cost",
		})
		expect(input.models).toEqual(["claude-opus-5"])
		expect(input.vendorIds).toEqual(["eve"])
		expect(input.agentNames).toBeUndefined()
	})

	it("asks for one short page, worst first", () => {
		const input = overviewSessionsInput({}, WINDOW, { sortBy: "durationMs" })
		expect(input.sortBy).toBe("durationMs")
		expect(input.sortDir).toBe("desc")
		expect(input.limit).toBe(6)
	})

	it("lets the errored tab ask for failures the board is not filtered to", () => {
		expect(
			overviewSessionsInput({}, WINDOW, { sortBy: "errorSpanCount", hasErrors: true }).hasErrors,
		).toBe(true)
	})
})
