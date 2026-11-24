import { describe, expect, it } from "vitest"
import { Array as Arr, Option } from "effect"
import {
	budgetHistory,
	budgetRemaining,
	burnRate,
	burnWindows,
	budgetSpent,
	budgetState,
	severityState,
	SLO_BURN_TIERS,
	sliRatio,
	tierBreached,
	tierFactor,
	tierState,
	type SloBucket,
} from "./slo"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const [critical, warning, slow] = SLO_BURN_TIERS

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
			[120, 10],
			[360, 3.3],
			[1440, 3.3],
		])
		expect(tierBreached(critical, windows, 99.9)).toBe(true)
		expect(tierBreached(warning, windows, 99.9)).toBe(false)
	})

	it("stops paging once the short window recovers, though the hour still burns", () => {
		const windows = burnWindows(
			minuteBuckets(endMs, 360, (ago) => (ago > 5 && ago <= 60 ? 20 : 0)),
			endMs,
			99.9,
		)
		expect(tierBreached(critical, windows, 99.9)).toBe(false)
	})

	it("tickets a slow burn over 6h and 30m", () => {
		// 0.8% errors for 6h: 8x, under the page factor, over the ticket factor.
		const windows = burnWindows(
			minuteBuckets(endMs, 360, () => 8),
			endMs,
			99.9,
		)
		expect(tierBreached(critical, windows, 99.9)).toBe(false)
		expect(tierBreached(warning, windows, 99.9)).toBe(true)
	})

	it("tickets a 4x burn that lasts a day, which the faster tiers never see", () => {
		const windows = burnWindows(
			minuteBuckets(endMs, 1440, () => 4),
			endMs,
			99.9,
		)
		expect(tierBreached(critical, windows, 99.9)).toBe(false)
		expect(tierBreached(warning, windows, 99.9)).toBe(false)
		expect(tierBreached(slow, windows, 99.9)).toBe(true)
		expect(severityState("warning", windows, 99.9)).toBe("breach")
		expect(severityState("critical", windows, 99.9)).toBe("clear")
	})

	it("does not fire on a handful of requests, and holds instead of clearing", () => {
		// One failed request out of three in the hour: a 333x burn that says nothing.
		const few = burnWindows(
			[
				{ startMs: endMs - 2 * MINUTE, total: 1, good: 0 },
				{ startMs: endMs - 20 * MINUTE, total: 2, good: 2 },
			],
			endMs,
			99.9,
		)
		expect(tierState(critical, few, 99.9)).toBe("hold")
		// Nor on a single failure among enough requests to count.
		const oneBad = burnWindows(
			[
				{ startMs: endMs - 2 * MINUTE, total: 6, good: 5 },
				{ startMs: endMs - 20 * MINUTE, total: 6, good: 6 },
			],
			endMs,
			99.9,
		)
		expect(tierState(critical, oneBad, 99.9)).toBe("hold")
		// The same share of failures on real traffic fires.
		const many = burnWindows(
			minuteBuckets(endMs, 60, () => 333),
			endMs,
			99.9,
		)
		expect(tierState(critical, many, 99.9)).toBe("breach")
	})

	it("caps a tier's factor under the highest burn a low target can reach", () => {
		expect(tierFactor(critical, 99.9)).toBe(14.4)
		// 90% tops out at a burn of 10, so it pages at 8.
		expect(tierFactor(critical, 90)).toBeCloseTo(8)
		expect(tierFactor(warning, 90)).toBe(6)
		// A total outage at a 90% target: 10x everywhere.
		const outage = burnWindows(
			minuteBuckets(endMs, 360, (ago) => (ago <= 60 ? 1000 : 0)),
			endMs,
			90,
		)
		expect(tierState(critical, outage, 90)).toBe("breach")
	})

	it("holds a tier whose short window saw no events", () => {
		const silent = burnWindows(
			Arr.filter(
				minuteBuckets(endMs, 360, () => 0),
				(bucket) => bucket.startMs < endMs - 10 * MINUTE,
			),
			endMs,
			99.9,
		)
		expect(tierState(critical, silent, 99.9)).toBe("hold")
		expect(tierState(warning, silent, 99.9)).toBe("clear")
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

describe("sampled traffic", () => {
	const endMs = Date.UTC(2026, 10, 6, 12, 0)

	it("judges a tier on the spans recorded, not on what sampling weighs them as", () => {
		// One recorded failure standing for ten: 10 bad of 120 weighted, 1 bad of 12 recorded.
		const sampled = burnWindows(
			[
				{ startMs: endMs - 2 * MINUTE, total: 10, good: 0, samples: 1 },
				{ startMs: endMs - 20 * MINUTE, total: 110, good: 110, samples: 11 },
			],
			endMs,
			99.9,
		)
		expect(tierState(critical, sampled, 99.9)).toBe("hold")
		// Two recorded failures of twelve is evidence.
		const twice = burnWindows(
			[
				{ startMs: endMs - 2 * MINUTE, total: 20, good: 0, samples: 2 },
				{ startMs: endMs - 20 * MINUTE, total: 100, good: 100, samples: 10 },
			],
			endMs,
			99.9,
		)
		expect(tierState(critical, twice, 99.9)).toBe("breach")
	})
})

describe("budgetState", () => {
	it("holds a spent budget's warning until the budget is back by a margin", () => {
		expect(budgetState({ total: 1_000_000, good: 998_000 }, 99.9)).toBe("breach")
		// 99.5% used: back above zero, not yet by 2%.
		expect(budgetState({ total: 1_000_000, good: 999_005 }, 99.9)).toBe("hold")
		expect(budgetState({ total: 1_000_000, good: 999_500 }, 99.9)).toBe("clear")
		// The failures that spent it aged out down to one, which still overspends: not recovered,
		// so an open warning stays open, and one failure alone still opens nothing.
		expect(budgetState({ total: 500, good: 499 }, 99.9)).toBe("hold")
		expect(budgetState({ total: 0, good: 0 }, 99.9)).toBe("clear")
	})
})

describe("budgetSpent", () => {
	it("is spent at or past the whole budget, on enough events to judge", () => {
		expect(budgetSpent({ total: 10_000, good: 9_990 }, 99.9)).toBe(true)
		expect(budgetSpent({ total: 10_000, good: 9_995 }, 99.9)).toBe(false)
		// Exactly the budget: ten failures in 100,000 at 99.99%, whatever the division leaves over.
		expect(budgetSpent({ total: 100_000, good: 99_990 }, 99.99)).toBe(true)
		// One failure overspends any small window's budget and proves nothing.
		expect(budgetSpent({ total: 5, good: 4 }, 99.9)).toBe(false)
		expect(budgetSpent({ total: 500, good: 499 }, 99.9)).toBe(false)
		expect(budgetSpent({ total: 0, good: 0 }, 99.9)).toBe(false)
	})
})
