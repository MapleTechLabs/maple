import { describe, expect, it } from "vitest"

import { limitsUpdate, parseDailyLimit, RUNS_PER_DAY_LIMITS } from "./ai-triage-limits"

describe("parseDailyLimit", () => {
	it("accepts whole numbers inside the bounds, ignoring surrounding space", () => {
		expect(parseDailyLimit(" 300 ", RUNS_PER_DAY_LIMITS)).toEqual({ ok: true, value: 300 })
		expect(parseDailyLimit("1", RUNS_PER_DAY_LIMITS)).toEqual({ ok: true, value: 1 })
		expect(parseDailyLimit("500", RUNS_PER_DAY_LIMITS)).toEqual({ ok: true, value: 500 })
	})

	it("rejects empty, fractional, negative and out of range input with the range", () => {
		for (const input of ["", "1.5", "-3", "0", "501", "1e3", "abc"]) {
			const parsed = parseDailyLimit(input, RUNS_PER_DAY_LIMITS)
			expect(parsed.ok).toBe(false)
			if (!parsed.ok) expect(parsed.message).toContain("1 to 500")
		}
	})
})

describe("limitsUpdate", () => {
	const saved = { maxRunsPerDay: 100, maxPassesPerDay: 1000 }

	it("sends only the ceilings that changed", () => {
		expect(limitsUpdate({ maxRunsPerDay: "300", maxPassesPerDay: "1000" }, saved)).toEqual({
			ok: true,
			maxRunsPerDay: 300,
			maxPassesPerDay: null,
		})
	})

	it("treats a retyped equal value as unchanged", () => {
		expect(limitsUpdate({ maxRunsPerDay: "0100", maxPassesPerDay: " 1000" }, saved)).toEqual({
			ok: true,
			maxRunsPerDay: null,
			maxPassesPerDay: null,
		})
	})

	it("refuses the save when either field is invalid", () => {
		expect(limitsUpdate({ maxRunsPerDay: "300", maxPassesPerDay: "5000" }, saved).ok).toBe(false)
	})
})
