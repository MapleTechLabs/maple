import { describe, expect, it } from "vitest"
import { Array as Arr, Option } from "effect"
import {
	budgetHistory,
	budgetRemaining,
	burnRate,
	burnWindows,
	SLO_BURN_TIERS,
	sliRatio,
	tierBreached,
	type SloBucket,
} from "./slo"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const [critical, warning] = SLO_BURN_TIERS

describe("SLO math", () => {
	it("reads a 99.9% target's budget from the bad share", () => {
		// 2 bad in 1000 at 99.9%: twice the allowed rate, the whole budget and as much again.
		expect(burnRate({ total: 1000, good: 998 }, 99.9)).toBeCloseTo(2)
		expect(budgetRemaining({ total: 1000, good: 998 }, 99.9)).toBeCloseTo(-1)
		expect(budgetRemaining({ total: 10_000, good: 9_995 }, 99.9)).toBeCloseTo(0.5)
		expect(sliRatio({ total: 1000, good: 998 })).toBeCloseTo(0.998)
	})

	it("treats a window without events as untouched", () => {
		expect(sliRatio({ total: 0, good: 0 })).toBeNull()
		expect(burnRate({ total: 0, good: 0 }, 99.9)).toBe(0)
		expect(budgetRemaining({ total: 0, good: 0 }, 99.9)).toBe(1)
	})
})

/** One bucket per minute over the last `minutes` before `endMs`, `bad` of 1000 bad in each. */
const minuteBuckets = (endMs: number, minutes: number, bad: (minutesAgo: number) => number) =>
	Arr.makeBy(minutes, (index): SloBucket => {
		const minutesAgo = index + 1
		return { startMs: endMs - minutesAgo * MINUTE, total: 1000, good: 1000 - bad(minutesAgo) }
	})

describe("burn windows and tiers", () => {
	const endMs = Date.UTC(2026, 10, 6, 12, 0)

	it("pages on a fast burn across both the 1h and 5m windows", () => {
		// 2% errors for the last hour at 99.9% burns 20x.
		const windows = burnWindows(
			minuteBuckets(endMs, 360, (ago) => (ago <= 60 ? 20 : 0)),
			endMs,
			99.9,
		)
		expect(
			Arr.map(windows, (window) => [window.windowMinutes, Math.round(window.burnRate * 10) / 10]),
		).toEqual([
			[5, 20],
			[30, 20],
			[60, 20],
			[360, 3.3],
		])
		expect(tierBreached(critical, windows)).toBe(true)
		expect(tierBreached(warning, windows)).toBe(false)
	})

	it("stops paging once the short window recovers, though the hour still burns", () => {
		const windows = burnWindows(
			minuteBuckets(endMs, 360, (ago) => (ago > 5 && ago <= 60 ? 20 : 0)),
			endMs,
			99.9,
		)
		expect(tierBreached(critical, windows)).toBe(false)
	})

	it("tickets a slow burn over 6h and 30m", () => {
		// 0.8% errors for 6h: 8x, under the page factor, over the ticket factor.
		const windows = burnWindows(
			minuteBuckets(endMs, 360, () => 8),
			endMs,
			99.9,
		)
		expect(tierBreached(critical, windows)).toBe(false)
		expect(tierBreached(warning, windows)).toBe(true)
	})

	it("ignores buckets outside the windows", () => {
		const windows = burnWindows(
			[...minuteBuckets(endMs, 360, () => 0), { startMs: endMs, total: 1000, good: 0 }],
			endMs,
			99.9,
		)
		expect(Arr.every(windows, (window) => window.burnRate === 0)).toBe(true)
	})
})

describe("budgetHistory", () => {
	it("reads the trailing window at each hour, ending on the partial current hour", () => {
		const windowMs = 24 * HOUR
		const endMs = Date.UTC(2026, 10, 6, 12, 30)
		// Two days of hourly buckets; one bad hour 30h ago (in the first window only) and one 2h ago.
		const firstBucket = Date.UTC(2026, 10, 4, 13)
		const buckets = Arr.makeBy(48, (index): SloBucket => {
			const startMs = firstBucket + index * HOUR
			const bad = startMs === Date.UTC(2026, 10, 5, 6) || startMs === Date.UTC(2026, 10, 6, 10) ? 50 : 0
			return { startMs, total: 1000, good: 1000 - bad }
		})
		const points = budgetHistory({ buckets, bucketMs: HOUR, windowMs, endMs, targetPercent: 99 })

		expect(points).toHaveLength(24)
		expect(points[points.length - 1]?.atMs).toBe(endMs)
		expect(points[0]?.atMs).toBe(Date.UTC(2026, 10, 5, 14))
		// 24 000 events allow 240 bad at 99%. The window ending at 14:00 on day 5 still holds
		// the 06:00 bad hour: 50/240 spent.
		expect(points[0]?.budgetRemaining).toBeCloseTo(1 - 50 / 240)
		// The latest window holds only the 10:00 bad hour.
		expect(points[points.length - 1]?.budgetRemaining).toBeCloseTo(1 - 50 / 240)
		// The bad hour's own point burns 5% / 1% = 5x.
		const badPoint = Arr.findFirst(points, (point) => point.atMs === Date.UTC(2026, 10, 6, 11))
		expect(Option.map(badPoint, (point) => [Math.round(point.burnRate * 100) / 100, point.sli])).toEqual(
			Option.some([5, 0.95]),
		)
	})
})
