import { afterEach, describe, expect, it, vi } from "vitest"
import {
	boundsForRange,
	chartWindow,
	formatLocalTimestamp,
	formatUtcTitle,
	parseClickHouseDateTime,
	snapToMinute,
} from "./time"

describe("boundsForRange", () => {
	afterEach(() => vi.useRealTimers())

	it("can advance every consumer from one explicit page anchor", () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-07-30T14:05:00Z"))
		const initial = boundsForRange("1h", Date.now())

		vi.setSystemTime(new Date("2026-07-30T16:05:00Z"))
		const advanced = boundsForRange("1h", Date.now())

		expect(initial).toEqual({ startTime: "2026-07-30 13:05:00", endTime: "2026-07-30 15:05:00" })
		expect(advanced).toEqual({ startTime: "2026-07-30 15:05:00", endTime: "2026-07-30 17:05:00" })
	})

	it("defaults an unknown key to the short default window", () => {
		const anchor = Date.parse("2026-07-30T14:05:00Z")
		expect(boundsForRange("nope", anchor).startTime).toBe("2026-07-30 13:05:00")
	})

	it("snaps anchors to the minute", () => {
		expect(snapToMinute(Date.parse("2026-07-30T14:05:59.900Z"))).toBe(Date.parse("2026-07-30T14:05:00Z"))
	})
})

describe("warehouse timestamps", () => {
	it("parses nanosecond-precision UTC strings", () => {
		expect(parseClickHouseDateTime("2026-07-30 23:06:01.940085000")).toBe(
			Date.parse("2026-07-30T23:06:01.940Z"),
		)
		expect(parseClickHouseDateTime("1970-01-01 00:00:00")).toBeNull()
		expect(parseClickHouseDateTime("")).toBeNull()
	})

	it("renders local wall-clock time with millis, and the date only on other days", () => {
		const raw = "2026-07-30 23:06:01.940085000"
		const local = new Date(Date.parse("2026-07-30T23:06:01.940Z"))
		const pad = (n: number, w = 2) => String(n).padStart(w, "0")
		const clock = `${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}.940`

		expect(formatLocalTimestamp(raw, { nowMs: local.getTime() + 1000 })).toBe(clock)
		const otherDay = formatLocalTimestamp(raw, { nowMs: local.getTime() + 3 * 24 * 60 * 60 * 1000 })
		expect(otherDay.endsWith(` ${clock}`)).toBe(true)
		expect(otherDay.length).toBeGreaterThan(clock.length + 1)
		expect(formatLocalTimestamp(raw, { precision: "s", nowMs: local.getTime() })).toBe(clock.slice(0, 8))
		expect(formatUtcTitle(raw)).toBe(`${raw} UTC`)
	})
})

describe("chartWindow", () => {
	const now = Date.parse("2026-07-30T14:05:00Z")

	it("charts a one-hour range at one-minute buckets", () => {
		const window = chartWindow(boundsForRange("1h", now), null, now)
		expect(window.bucketSeconds).toBe(60)
		expect(window.endMs).toBe(now)
	})

	it("clips a wide range to when data first arrived", () => {
		const firstSeen = now - 60 * 60 * 1000
		const window = chartWindow(boundsForRange("30d", now), firstSeen, now)
		expect(window.startMs).toBe(firstSeen)
		expect(window.bucketSeconds).toBe(60)
	})

	it("uses rollup-aligned buckets for long ranges instead of 10080s ones", () => {
		const window = chartWindow(boundsForRange("7d", now), null, now)
		expect(window.bucketSeconds % 3600).toBe(0)
	})
})
