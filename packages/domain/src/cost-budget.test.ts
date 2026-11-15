import { describe, expect, it } from "vitest"
import { Array as Arr, Option, String as Str } from "effect"
import {
	type CostBudgetTier,
	costBudgetPeriodWindow,
	costBudgetProgress,
	costBudgetReachedTier,
	costBudgetTierStatus,
} from "./cost-budget"

const at = (iso: string) => Date.parse(iso)

describe("costBudgetPeriodWindow", () => {
	it("covers the calendar month the instant is in", () => {
		expect(costBudgetPeriodWindow("month", at("2026-11-15T09:30:00Z"))).toMatchObject({
			startDay: "2026-11-01",
			endDay: "2026-11-30",
			days: 30,
		})
	})

	it("ends a leap February on the 29th", () => {
		expect(costBudgetPeriodWindow("month", at("2028-02-10T00:00:00Z"))).toMatchObject({
			startDay: "2028-02-01",
			endDay: "2028-02-29",
			days: 29,
		})
	})

	it("covers the quarter, whichever of its months the instant is in", () => {
		const fourth = { startDay: "2026-10-01", endDay: "2026-12-31", days: 92 }
		expect(costBudgetPeriodWindow("quarter", at("2026-10-01T00:00:00Z"))).toMatchObject(fourth)
		expect(costBudgetPeriodWindow("quarter", at("2026-12-31T23:59:59Z"))).toMatchObject(fourth)
		expect(costBudgetPeriodWindow("quarter", at("2026-02-14T12:00:00Z"))).toMatchObject({
			startDay: "2026-01-01",
			endDay: "2026-03-31",
			days: 90,
		})
	})

	it("covers the calendar year", () => {
		expect(costBudgetPeriodWindow("year", at("2026-07-04T00:00:00Z"))).toMatchObject({
			startDay: "2026-01-01",
			endDay: "2026-12-31",
			days: 365,
		})
	})

	it("turns over at midnight UTC, not before", () => {
		expect(costBudgetPeriodWindow("month", at("2026-11-30T23:59:59Z")).startDay).toBe("2026-11-01")
		expect(costBudgetPeriodWindow("month", at("2026-12-01T00:00:00Z")).startDay).toBe("2026-12-01")
	})
})

describe("costBudgetProgress", () => {
	const budget = { amount: 1000, period: "month" } as const

	it("sums the period's days and leaves out the ones before it", () => {
		const progress = costBudgetProgress(budget, at("2026-11-11T12:00:00Z"), [
			{ day: "2026-10-31", cost: 900 },
			{ day: "2026-11-01", cost: 100 },
			{ day: "2026-11-10", cost: 150 },
		])
		expect(progress).toMatchObject({
			periodStart: "2026-11-01",
			periodEnd: "2026-11-30",
			periodDays: 30,
			spent: 250,
			percent: 25,
		})
	})

	it("forecasts a straight run rate over the complete days before today", () => {
		// Ten complete days, 300 spent: 30 a day over 30 days.
		const progress = costBudgetProgress(budget, at("2026-11-11T12:00:00Z"), [
			{ day: "2026-11-03", cost: 100 },
			{ day: "2026-11-10", cost: 200 },
		])
		expect(progress).toMatchObject({ elapsedDays: 10, forecast: 900, forecastPercent: 90 })
	})

	// Today is still filling: counting it as a whole day would read the rate low until midnight.
	it("counts today's cost as spent, and not as a day of the run rate", () => {
		const progress = costBudgetProgress(budget, at("2026-11-11T12:00:00Z"), [
			{ day: "2026-11-10", cost: 300 },
			{ day: "2026-11-11", cost: 30 },
		])
		expect(progress).toMatchObject({ spent: 330, elapsedDays: 10, forecast: 900 })
	})

	// A provider that reports a day late has no row for yesterday until its next sync. The
	// forecast must not drop at midnight and come back after the sync.
	it("holds its forecast across midnight while a provider's last day is not in yet", () => {
		const steady = (through: number) =>
			Arr.makeBy(through, (index) => ({
				day: `2026-11-${Str.padStart(2, "0")(String(index + 1))}`,
				cost: 40,
			}))
		const forecastAt = (now: string, through: number) =>
			costBudgetProgress(budget, at(now), steady(through)).forecast

		expect(forecastAt("2026-11-10T23:55:00Z", 9)).toBe(1200)
		expect(forecastAt("2026-11-11T00:05:00Z", 9)).toBe(1200)
		expect(forecastAt("2026-11-11T06:00:00Z", 10)).toBe(1200)
	})

	// Past the lag a provider can have, a day without cost is a day nothing was spent: one
	// charge early in the period is not a daily rate.
	it("spreads a single early charge over the days since, not over the day it fell on", () => {
		const progress = costBudgetProgress(budget, at("2026-11-20T12:00:00Z"), [
			{ day: "2026-11-02", cost: 340 },
		])
		expect(progress).toMatchObject({ elapsedDays: 17, forecast: 600 })
	})

	it("makes no forecast in the period's first days", () => {
		const progress = costBudgetProgress(budget, at("2026-11-03T06:00:00Z"), [
			{ day: "2026-11-01", cost: 400 },
		])
		expect(progress).toMatchObject({ spent: 400, forecast: null, forecastPercent: null })
	})

	it("stands at zero, with a zero forecast, when nothing is spent", () => {
		const progress = costBudgetProgress(budget, at("2026-11-20T00:00:00Z"), [])
		expect(progress).toMatchObject({ spent: 0, percent: 0, forecast: 0, forecastPercent: 0 })
	})

	it("never forecasts less than what is already spent", () => {
		// Everything was spent today: no complete day has a rate, and the total stands.
		const progress = costBudgetProgress(budget, at("2026-11-30T12:00:00Z"), [
			{ day: "2026-11-30", cost: 600 },
		])
		expect(progress.forecast).toBe(600)
	})
})

describe("costBudgetReachedTier", () => {
	const tiers: ReadonlyArray<CostBudgetTier> = [
		{ severity: "warning", percent: 100, basis: "forecast" },
		{ severity: "critical", percent: 100, basis: "actual" },
	]
	const progressAt = (spent: number) =>
		costBudgetProgress({ amount: 1000, period: "month" }, at("2026-11-16T00:00:00Z"), [
			{ day: "2026-11-15", cost: spent },
		])

	it("reaches no tier while spend and forecast are under their percents", () => {
		expect(costBudgetReachedTier(progressAt(400), tiers)).toEqual(Option.none())
	})

	it("reaches the forecast tier before the money is spent", () => {
		// 600 in 15 days projects to 1200.
		expect(Option.getOrThrow(costBudgetReachedTier(progressAt(600), tiers)).severity).toBe("warning")
	})

	it("reaches the most severe tier once both are", () => {
		expect(Option.getOrThrow(costBudgetReachedTier(progressAt(1100), tiers)).severity).toBe("critical")
	})

	// A run rate moves a little every day: just under its percent, a forecast tier neither
	// opens nor clears, so an incident does not close and reopen around the line.
	it("holds a forecast tier that is just under its percent, and clears it well under", () => {
		const forecastTier = { severity: "warning", percent: 100, basis: "forecast" } as const
		const actualTier = { severity: "critical", percent: 100, basis: "actual" } as const
		// 485 in 15 days projects to 970, 97% of the amount; 460 to 920.
		expect(costBudgetTierStatus(progressAt(485), forecastTier)).toBe("hold")
		expect(costBudgetTierStatus(progressAt(460), forecastTier)).toBe("clear")
		expect(costBudgetTierStatus(progressAt(500), forecastTier)).toBe("breach")
		// Money spent has no such band: under the percent is under.
		expect(costBudgetTierStatus(progressAt(970), actualTier)).toBe("clear")
	})

	it("holds a forecast tier back until a forecast exists", () => {
		const early = costBudgetProgress({ amount: 1000, period: "month" }, at("2026-11-02T00:00:00Z"), [
			{ day: "2026-11-01", cost: 900 },
		])
		expect(costBudgetReachedTier(early, tiers)).toEqual(Option.none())
	})
})
