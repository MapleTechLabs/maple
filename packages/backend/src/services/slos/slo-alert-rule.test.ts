import { describe, expect, it } from "vitest"
import { Array as Arr } from "effect"
import { SLO_BURN_WINDOWS_MINUTES, type SloBurnWindow } from "@maple/domain/slo"
import { evaluateSloBudget, evaluateSloBurn, sloRuleFields, type SloBurnInput } from "./slo-alert-rule"

/** Every burn window at the given rates, keyed by window length; 1000 events each, 100 of them bad. */
const windows = (rates: Record<number, number>): ReadonlyArray<SloBurnWindow> =>
	Arr.map(SLO_BURN_WINDOWS_MINUTES, (windowMinutes) => ({
		windowMinutes,
		total: 1000,
		good: 900,
		burnRate: rates[windowMinutes] ?? 0,
	}))

const check = (
	burnWindows: ReadonlyArray<SloBurnWindow>,
	overrides: Partial<SloBurnInput> = {},
): SloBurnInput => ({ windows: burnWindows, targetPercent: 99.9, ...overrides })

const emptied = (burnWindows: ReadonlyArray<SloBurnWindow>, ...minutes: ReadonlyArray<number>) =>
	Arr.map(burnWindows, (window) =>
		Arr.contains(minutes, window.windowMinutes) ? { ...window, total: 0, good: 0 } : window,
	)

describe("evaluateSloBurn", () => {
	it("names the firing tier's windows", () => {
		const evaluation = evaluateSloBurn(check(windows({ 5: 8, 30: 8, 60: 7, 360: 7 })))
		expect(evaluation.status).toBe("breached")
		expect(evaluation.reason).toBe(
			"SLO burning the error budget at 7x over 6h and 8x over 30m (warning at 6x)",
		)
	})

	it("names the slow tier when only a day-long burn fires", () => {
		const evaluation = evaluateSloBurn(check(windows({ 5: 4, 30: 4, 60: 4, 120: 4, 360: 4, 1440: 4 })))
		expect(evaluation.status).toBe("breached")
		expect(evaluation.levels).toEqual([
			{ severity: "warning", status: "breach" },
			{ severity: "critical", status: "clear" },
		])
		expect(evaluation.reason).toBe(
			"SLO burning the error budget at 4x over 24h and 4x over 2h (warning at 3x)",
		)
	})

	it("names every tier on recovery, so a resolved warning reports its own windows", () => {
		const evaluation = evaluateSloBurn(
			check(windows({ 5: 0.2, 30: 0.3, 60: 0.4, 120: 0.5, 360: 0.5, 1440: 0.6 })),
		)
		expect(evaluation.status).toBe("healthy")
		expect(evaluation.reason).toBe(
			"SLO within budget: 0.4x over 1h and 0.2x over 5m (critical at 14.4x); 0.5x over 6h and 0.3x over 30m (warning at 6x); 0.6x over 24h and 0.5x over 2h (warning at 3x)",
		)
	})

	it("fires at the burn a low target can reach, and says so", () => {
		// 90% tops out at 10x: a total outage must still page.
		const evaluation = evaluateSloBurn(check(windows({ 5: 10, 30: 10, 60: 10 }), { targetPercent: 90 }))
		expect(evaluation.levels).toEqual([
			{ severity: "warning", status: "clear" },
			{ severity: "critical", status: "breach" },
		])
		expect(evaluation.reason).toBe(
			"SLO burning the error budget at 10x over 1h and 10x over 5m (critical at 8x)",
		)
	})

	it("holds the critical tier while its 5m window is empty and still fires the warning", () => {
		const evaluation = evaluateSloBurn(check(emptied(windows({ 30: 8, 60: 20, 360: 7 }), 5)))
		expect(evaluation.status).toBe("breached")
		expect(evaluation.levels).toEqual([
			{ severity: "warning", status: "breach" },
			{ severity: "critical", status: "hold" },
		])
	})

	it("holds the critical tier while its 5m window is empty even as the warning clears", () => {
		const evaluation = evaluateSloBurn(check(emptied(windows({ 30: 0.5, 60: 20, 360: 0.5 }), 5)))
		// Healthy overall, but the held tier keeps an open critical incident from resolving.
		expect(evaluation.status).toBe("healthy")
		expect(evaluation.levels).toEqual([
			{ severity: "warning", status: "clear" },
			{ severity: "critical", status: "hold" },
		])
	})

	it("holds, not clears, a severity that burns on too few events to judge", () => {
		const few = Arr.map(
			windows({ 5: 300, 30: 300, 60: 300, 120: 300, 360: 300, 1440: 300 }),
			(window) => ({
				...window,
				total: 3,
				good: 2,
			}),
		)
		const evaluation = evaluateSloBurn(check(few))
		expect(evaluation.status).toBe("healthy")
		expect(evaluation.levels).toEqual([
			{ severity: "warning", status: "hold" },
			{ severity: "critical", status: "hold" },
		])
	})

	it("skips as no data when every short window is empty", () => {
		expect(evaluateSloBurn(check(emptied(windows({}), 5, 30, 120)))).toMatchObject({
			status: "skipped",
			skipReason: "no_data",
			levels: [],
		})
	})

	it("still judges the slow tier while only the fast short windows are empty", () => {
		// Dead for half an hour: the 2h window still holds what it sent before.
		const evaluation = evaluateSloBurn(check(emptied(windows({ 120: 1, 1440: 1 }), 5, 30)))
		expect(evaluation.status).toBe("healthy")
		expect(evaluation.levels).toEqual([
			{ severity: "warning", status: "hold" },
			{ severity: "critical", status: "hold" },
		])
	})
})

describe("evaluateSloBudget", () => {
	const budget = (totals: { total: number; good: number } | "notDue" | "unread") =>
		evaluateSloBudget({
			targetPercent: 99.9,
			windowDays: 30,
			budget: typeof totals === "string" ? { _tag: totals } : { _tag: "read", totals },
		})

	it("is a warning while the window's budget is spent, with the share used as its value", () => {
		const evaluation = budget({ total: 1_000_000, good: 998_000 })
		expect(evaluation.status).toBe("breached")
		expect(evaluation.value).toBeCloseTo(2)
		expect(evaluation.levels).toEqual([
			{ severity: "warning", status: "breach" },
			{ severity: "critical", status: "clear" },
		])
		expect(evaluation.reason).toBe("SLO error budget is spent: 200% of the 30-day budget used")
	})

	it("holds just under the budget, so a warning neither opens nor clears at the line", () => {
		const evaluation = budget({ total: 1_000_000, good: 999_005 })
		expect(evaluation.status).toBe("healthy")
		expect(evaluation.levels[0]).toEqual({ severity: "warning", status: "hold" })
	})

	it("is clear with budget left", () => {
		const evaluation = budget({ total: 1_000_000, good: 999_500 })
		expect(evaluation.status).toBe("healthy")
		expect(evaluation.levels[0]).toEqual({ severity: "warning", status: "clear" })
		expect(evaluation.reason).toBe("SLO error budget is back: 50% of the 30-day budget used")
	})

	it("judges nothing on a check that did not read the window", () => {
		expect(budget("notDue")).toMatchObject({ status: "skipped", levels: [] })
		expect(budget("unread")).toMatchObject({ status: "skipped", levels: [] })
	})
})

describe("sloRuleFields", () => {
	const fields = (targetPercent: number) =>
		sloRuleFields({
			name: "Checkout availability",
			serviceName: "checkout",
			environments: [],
			targetPercent,
			enabled: true,
			criticalDestinationIds: [],
			warningDestinationIds: [],
		})

	it("stores the burn each severity fires at for the target", () => {
		expect(Arr.map(fields(99.9).thresholdsJson, (tier) => [tier.severity, tier.value])).toEqual([
			["warning", 3],
			["critical", 14.4],
		])
		const low = Arr.map(fields(75).thresholdsJson, (tier) => [tier.severity, tier.value])
		// 75% tops out at 4x, so both tiers fire at 3.2x or less.
		expect(low[0]?.[1]).toBe(3)
		expect(low[1]?.[1]).toBeCloseTo(3.2)
	})
})
