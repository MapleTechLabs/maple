import { describe, expect, it } from "vitest"
import { replayPartitionWindow } from "./replay-format"

// The session-detail warehouse queries are PARTITION BY toDate(...) over a 30-day
// TTL; `replayPartitionWindow` turns a session's start (and optional end) into the
// TinybirdDateTime window that prunes those daily partitions. The strings it emits
// MUST match the `YYYY-MM-DD HH:mm:ss` shape the domain `TinybirdDateTime` schema
// accepts, or the request would be rejected before it leaves the browser.
describe("replayPartitionWindow", () => {
	it("derives a [start - 1h, start + 24h] window from a start-only hint", () => {
		const w = replayPartitionWindow("2026-06-24 05:16:41.023800000")
		expect(w).toEqual({
			windowStart: "2026-06-24 04:16:41",
			windowEnd: "2026-06-25 05:16:41",
		})
	})

	it("uses the session end (+1h margin) for the upper bound when provided", () => {
		const w = replayPartitionWindow("2026-06-24 05:16:41", "2026-06-24 05:40:00")
		expect(w).toEqual({
			windowStart: "2026-06-24 04:16:41",
			windowEnd: "2026-06-24 06:40:00",
		})
	})

	it("emits `YYYY-MM-DD HH:mm:ss` strings (no fractional seconds, space-separated)", () => {
		const w = replayPartitionWindow("2026-06-24 05:16:41.5")
		expect(w?.windowStart).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
		expect(w?.windowEnd).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
	})

	it("returns undefined for a missing or unparseable hint (deep-link full-scan fallback)", () => {
		expect(replayPartitionWindow(undefined)).toBeUndefined()
		expect(replayPartitionWindow(null)).toBeUndefined()
		expect(replayPartitionWindow("")).toBeUndefined()
		expect(replayPartitionWindow("not-a-timestamp")).toBeUndefined()
	})
})
