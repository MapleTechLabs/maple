import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { DATA_RATES, dailyGbMonths, daysInUtcMonth, estimateMonthlyStorageCost } from "./storage-pricing"

describe("estimateMonthlyStorageCost", () => {
	it("prices a full period: 100 GB of logs a month kept 90 days is about $45", () => {
		const avgDailyGb = 100 / 30
		expect(estimateMonthlyStorageCost(avgDailyGb, 90, DATA_RATES.storagePerGbMonth)).toBeCloseTo(45, 6)
	})

	it("grows with the period and costs nothing with nothing ingested", () => {
		expect(estimateMonthlyStorageCost(2, 30, 0.15)).toBeCloseTo(9, 6)
		expect(estimateMonthlyStorageCost(2, 365, 0.15)).toBeCloseTo(109.5, 6)
		expect(estimateMonthlyStorageCost(0, 730, 0.15)).toBe(0)
		expect(estimateMonthlyStorageCost(-1, 30, 0.15)).toBe(0)
	})
})

describe("daily storage share", () => {
	it("splits a month's GB stored over the days of that UTC month", () => {
		expect(daysInUtcMonth(Date.UTC(2026, 1, 14))).toBe(28)
		expect(daysInUtcMonth(Date.UTC(2028, 1, 29, 23, 59))).toBe(29)
		expect(daysInUtcMonth(Date.UTC(2026, 10, 30, 23, 59))).toBe(30)
		expect(dailyGbMonths(310, Date.UTC(2026, 11, 1))).toBeCloseTo(10, 9)
	})

	it("adds up to the GB stored over a whole month held flat", () => {
		const days = daysInUtcMonth(Date.UTC(2026, 0, 1))
		const month = Arr.makeBy(days, (day) => dailyGbMonths(300, Date.UTC(2026, 0, day + 1)))
		expect(Arr.reduce(month, 0, (sum, value) => sum + value)).toBeCloseTo(300, 9)
	})
})
