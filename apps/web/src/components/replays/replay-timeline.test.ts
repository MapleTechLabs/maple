import { describe, it, expect } from "vitest"
import { formatWarehouseDateTimeMs } from "@maple/query-engine"
import { parseChTimestampMs, spanRange } from "./replay-timeline"

describe("parseChTimestampMs", () => {
	const expected = Date.UTC(2026, 4, 22, 10, 30, 45, 123)

	it("parses a space-separated ClickHouse DateTime64 as UTC", () => {
		expect(parseChTimestampMs("2026-05-22 10:30:45.123")).toBe(expected)
	})

	it("parses without fractional seconds", () => {
		expect(parseChTimestampMs("2026-05-22 10:30:45")).toBe(Date.UTC(2026, 4, 22, 10, 30, 45))
	})

	it("accepts an explicit zone or T separator without double-appending Z", () => {
		expect(parseChTimestampMs("2026-05-22T10:30:45.123Z")).toBe(expected)
		expect(parseChTimestampMs("2026-05-22 10:30:45.123Z")).toBe(expected)
	})

	it("returns NaN for empty/garbage input", () => {
		expect(Number.isNaN(parseChTimestampMs(""))).toBe(true)
		expect(Number.isNaN(parseChTimestampMs("not-a-date"))).toBe(true)
	})
})

describe("spanRange", () => {
	// Recording starts at this epoch ms; the playhead's time-zero.
	const recordingStartEpochMs = Date.UTC(2026, 4, 22, 10, 30, 45, 0)
	const isoAt = (offsetMs: number) => formatWarehouseDateTimeMs(recordingStartEpochMs + offsetMs)

	it("maps a span's absolute start to a rrweb-relative offset", () => {
		const r = spanRange({
			spanStartIso: isoAt(10_000),
			durationMs: 2_000,
			recordingStartEpochMs,
			realTotalMs: 60_000,
		})
		expect(r.realOffsetMs).toBe(10_000)
		expect(r.startMs).toBe(10_000)
		expect(r.endMs).toBe(12_000)
		expect(r.outOfRange).toBe(false)
	})

	it("flags and pins a span starting before the recording", () => {
		const r = spanRange({
			spanStartIso: isoAt(-5_000),
			durationMs: 1_000,
			recordingStartEpochMs,
			realTotalMs: 60_000,
		})
		expect(r.realOffsetMs).toBe(-5_000)
		expect(r.outOfRange).toBe(true)
		// Pinned to the left edge.
		expect(r.startMs).toBe(0)
	})

	it("flags a span starting after the recording ends", () => {
		const r = spanRange({
			spanStartIso: isoAt(75_000),
			durationMs: 1_000,
			recordingStartEpochMs,
			realTotalMs: 60_000,
		})
		expect(r.outOfRange).toBe(true)
		expect(r.startMs).toBe(60_000)
	})

	it("treats an unparseable timestamp as out of range", () => {
		const r = spanRange({
			spanStartIso: "garbage",
			durationMs: 1_000,
			recordingStartEpochMs,
			realTotalMs: 60_000,
		})
		expect(r.outOfRange).toBe(true)
		expect(r.startMs).toBe(0)
	})
})
