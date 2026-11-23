import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { PREVIEW_MAX_SCAN_ROWS, scanMinutes, suggestRules, summarize } from "./IngestRulePreviewService"

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

describe("suggested ingest rules", () => {
	const KB = 1000
	const spanSizes = new Map([
		["api", 500],
		["shop", 500],
	])

	it("drops debug logs and health-check spans, busiest savings first", () => {
		const suggestions = suggestRules(
			[
				{ serviceName: "checkout", level: "debug", records: 50_000, bytes: 20_000 * KB },
				{ serviceName: "checkout", level: "other", records: 100_000, bytes: 60_000 * KB },
			],
			[
				{ serviceName: "api", spanName: "GET /healthz", records: 20_000 },
				{ serviceName: "shop", spanName: "POST /shipping", records: 2_000 },
				{ serviceName: "shop", spanName: "GET /orders/:id/ready", records: 2_000 },
				{ serviceName: "shop", spanName: "GET /streams/live", records: 2_000 },
			],
			spanSizes,
			{ logBytes: 80_000 * KB, spanBytes: 26_000 * 500 },
		)
		expect(Arr.map(suggestions, (entry) => [entry.reason, entry.serviceName, entry.keepPercent])).toEqual(
			[
				["debug_logs", "checkout", 0],
				["health_checks", "api", 0],
			],
		)
		expect(suggestions[1]).toMatchObject({ spanName: "GET /healthz", savedBytes: 20_000 * 500 })
	})

	it("samples a service's logs below warn when its info logs dominate, counting its debug logs too", () => {
		const suggestions = suggestRules(
			[
				{ serviceName: "api", level: "info", records: 900_000, bytes: 900_000 * KB },
				{ serviceName: "api", level: "debug", records: 100_000, bytes: 100_000 * KB },
				{ serviceName: "web", level: "info", records: 50_000, bytes: 50_000 * KB },
			],
			// A busy operation is never sampled: the gateway would keep the rest of its traces.
			[{ serviceName: "api", spanName: "GET /orders", records: 400_000 }],
			spanSizes,
			{ logBytes: 1_050_000 * KB, spanBytes: 400_000 * 500 },
		)
		expect(Arr.map(suggestions, (entry) => [entry.reason, entry.serviceName, entry.keepPercent])).toEqual(
			[
				["info_logs", "api", 10],
				["debug_logs", "api", 0],
			],
		)
		expect(suggestions[0]).toMatchObject({ records: 1_000_000, bytes: 1_000_000 * KB })
		expect(suggestions[0]?.savedBytes).toBeCloseTo(1_000_000 * KB * 0.9)
	})

	it("suggests nothing for an org with no data", () => {
		expect(suggestRules([], [], new Map(), { logBytes: 0, spanBytes: 0 })).toEqual([])
	})

	it("measures shares against everything stored, not only the busiest rows read", () => {
		// The rollup read keeps the busiest 200 groups; a level that is 15% of those can be 1.5% of all.
		const suggestions = suggestRules(
			[{ serviceName: "api", level: "info", records: 150_000, bytes: 150_000 * KB }],
			[],
			spanSizes,
			{ logBytes: 10_000_000 * KB, spanBytes: 0 },
		)
		expect(suggestions).toEqual([])
	})
})
