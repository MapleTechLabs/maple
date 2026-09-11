import { describe, expect, it } from "vitest"

import { toolAnalyticsSelection } from "./use-tool-analytics"

const WINDOW = { startTime: "2026-09-03 12:00:00", endTime: "2026-09-10 12:00:00" }

describe("toolAnalyticsSelection", () => {
	it("carries every filter the URL holds into the reads", () => {
		expect(
			toolAnalyticsSelection(
				{ tool: "bash", model: "claude-opus-5", service: "ci-runner", env: "production" },
				WINDOW,
			),
		).toEqual({
			...WINDOW,
			tool: "bash",
			model: "claude-opus-5",
			service: "ci-runner",
			env: "production",
			search: undefined,
			failingOnly: undefined,
		})
	})

	it("drops a blank search box rather than searching for the empty string", () => {
		// The contract refuses an empty needle, so a cleared box has to become no
		// filter on the way out — not a 400 on every keystroke back to nothing.
		expect(toolAnalyticsSelection({ q: "   " }, WINDOW).search).toBeUndefined()
		expect(toolAnalyticsSelection({ q: "  run_sql " }, WINDOW).search).toBe("run_sql")
	})

	it("sends the failing-only switch only while it is on", () => {
		expect(toolAnalyticsSelection({ failing: true }, WINDOW).failingOnly).toBe(true)
		// `false` is not "no filter" to a cache key — an off switch has to leave
		// the same selection an untouched one does.
		expect(toolAnalyticsSelection({ failing: false }, WINDOW).failingOnly).toBeUndefined()
	})
})
