import { describe, expect, it } from "vitest"
import { Array as Arr } from "effect"
import { SLO_BURN_WINDOWS_MINUTES, type SloBurnWindow } from "@maple/domain/slo"
import { evaluateSloBurn } from "./slo-alert-rule"

/** Every burn window at the given rates, keyed by window length; 1000 events each. */
const windows = (rates: Record<number, number>): ReadonlyArray<SloBurnWindow> =>
	Arr.map(SLO_BURN_WINDOWS_MINUTES, (windowMinutes) => ({
		windowMinutes,
		total: 1000,
		good: 1000,
		burnRate: rates[windowMinutes] ?? 0,
	}))

describe("evaluateSloBurn", () => {
	it("names the firing tier's windows", () => {
		const evaluation = evaluateSloBurn(windows({ 5: 8, 30: 8, 60: 7, 360: 7 }))
		expect(evaluation.status).toBe("breached")
		expect(evaluation.reason).toBe(
			"SLO burning the error budget at 7x over 6h and 8x over 30m (warning at 6x)",
		)
	})

	it("names every tier on recovery, so a resolved warning reports its own windows", () => {
		const evaluation = evaluateSloBurn(windows({ 5: 0.2, 30: 0.3, 60: 0.4, 360: 0.5 }))
		expect(evaluation.status).toBe("healthy")
		expect(evaluation.reason).toBe(
			"SLO within budget: 0.4x over 1h and 0.2x over 5m (critical at 14.4x); 0.5x over 6h and 0.3x over 30m (warning at 6x)",
		)
	})

	it("holds the critical tier while its 5m window is empty and still fires the warning", () => {
		const evaluation = evaluateSloBurn(
			Arr.map(windows({ 30: 8, 60: 20, 360: 7 }), (window) =>
				window.windowMinutes === 5 ? { ...window, total: 0, good: 0 } : window,
			),
		)
		expect(evaluation.status).toBe("breached")
		expect(evaluation.levels).toEqual([
			{ severity: "warning", status: "breach" },
			{ severity: "critical", status: "hold" },
		])
	})

	it("skips as no data when every short window is empty", () => {
		const empty = Arr.map(windows({}), (window) =>
			window.windowMinutes === 5 || window.windowMinutes === 30
				? { ...window, total: 0, good: 0 }
				: window,
		)
		expect(evaluateSloBurn(empty)).toMatchObject({ status: "skipped", skipReason: "no_data", levels: [] })
	})
})
