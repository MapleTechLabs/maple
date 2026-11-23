import { describe, expect, it } from "vitest"
import { Array as Arr } from "effect"
import { PREVIEW_MAX_SCAN_ROWS, scanMinutes, summarize } from "./IngestRulePreviewService"

describe("ingest rule preview totals", () => {
	const rows = [
		{ serviceName: "checkout", total: 1000, matched: 400 },
		{ serviceName: "api", total: 500, matched: 100 },
		{ serviceName: "quiet", total: 50, matched: 0 },
	]
	const sizes = new Map([
		["checkout", 300],
		["api", 1000],
	])

	it("drops each service's matches at that service's record size", () => {
		const preview = summarize("logs", rows, sizes, 1)
		expect(preview).toMatchObject({ stored: 1550, matched: 500, estimatedDropped: 500 })
		expect(preview.estimatedDroppedBytes).toBe(400 * 300 + 100 * 1000)
	})

	it("keeps the sampled share and counts no bytes for a service the usage rollup lacks", () => {
		const preview = summarize("traces", rows, new Map([["api", 1000]]), 0.9)
		expect(preview.estimatedDropped).toBe(450)
		expect(preview.estimatedDroppedBytes).toBe(90 * 1000)
	})

	it("scans the longest stretch of newest hours that fits, even after a burst", () => {
		const cap = PREVIEW_MAX_SCAN_ROWS
		expect(scanMinutes(Arr.makeBy(25, () => cap / 100))).toBe(24 * 60)
		// A burst ten hours back: the newest three hours (four buckets) fit, the rest do not.
		const burst = [cap / 10, cap / 10, cap / 10, cap / 10, ...Arr.makeBy(21, () => cap)]
		expect(scanMinutes(burst)).toBe(3 * 60)
		// Not even an hour fits: the minutes the busier of the two newest buckets allows.
		expect(scanMinutes([cap * 2, cap * 6])).toBe(10)
	})

	it("applies each service's match rate in the scanned stretch to its stored records for the day", () => {
		const scanned = summarize(
			"logs",
			rows,
			sizes,
			1,
			60,
			new Map([
				["checkout", 24_000],
				["api", 12_000],
			]),
		)
		expect(scanned.scannedMinutes).toBe(60)
		expect(scanned.services).toEqual([
			{ serviceName: "checkout", stored: 24_000, matched: 9600 },
			{ serviceName: "api", stored: 12_000, matched: 2400 },
		])
	})

	it("lists the services with matches, busiest first", () => {
		expect(summarize("logs", rows, sizes, 0).services).toEqual([
			{ serviceName: "checkout", stored: 1000, matched: 400 },
			{ serviceName: "api", stored: 500, matched: 100 },
		])
		expect(summarize("logs", rows, sizes, 0).estimatedDropped).toBe(0)
	})
})
