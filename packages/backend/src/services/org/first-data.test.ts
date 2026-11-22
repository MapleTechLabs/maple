import { describe, expect, it } from "vitest"
import { Array as Arr } from "effect"
import { isProbeDue } from "./FirstDataSweepService"
import { firstDataTimestamp } from "./first-data"

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0)
const HOUR = 3_600_000
const DAY = 24 * HOUR
const WINDOW_START = NOW - 30 * DAY

const seenAt = (firstSeenMs: number | null) => ({
	signals: ["traces"],
	firstSeenMs,
	windowStartMs: WINDOW_START,
})

describe("firstDataTimestamp", () => {
	it("dates the event by the first data hour", () => {
		expect(firstDataTimestamp(seenAt(NOW - 5 * HOUR), NOW - 2 * DAY, NOW)).toBe(NOW - 5 * HOUR)
	})

	it("never dates it before the org existed, since the data hour is floored", () => {
		expect(firstDataTimestamp(seenAt(NOW - 5 * HOUR), NOW - 4.5 * HOUR, NOW)).toBe(NOW - 4.5 * HOUR)
	})

	it("uses now when the data may predate the window or ingest would refuse it as too old", () => {
		expect(firstDataTimestamp(seenAt(WINDOW_START), null, NOW)).toBe(NOW)
		expect(firstDataTimestamp(seenAt(NOW - 29.5 * DAY), null, NOW)).toBe(NOW)
		expect(firstDataTimestamp(seenAt(null), null, NOW)).toBe(NOW)
	})
})

describe("isProbeDue", () => {
	const ticks = (sinceMs: number) =>
		Arr.filter(
			Arr.makeBy(24, (hour) => isProbeDue("org_probe", sinceMs, NOW + hour * HOUR)),
			Boolean,
		).length

	it("probes a young org every hourly tick and an older one every sixth", () => {
		expect(ticks(NOW - DAY)).toBe(24)
		expect(ticks(NOW - 10 * DAY)).toBe(4)
	})
})
