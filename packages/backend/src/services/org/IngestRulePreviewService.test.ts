import { describe, expect, it } from "vitest"
import { PREVIEW_MAX_SCAN_ROWS, scanHours, summarize } from "./IngestRulePreviewService"

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

	it("scans the whole day until a day outgrows the budget, then the latest hours scaled to a day", () => {
		expect(scanHours(PREVIEW_MAX_SCAN_ROWS)).toBe(24)
		expect(scanHours(PREVIEW_MAX_SCAN_ROWS * 4)).toBe(6)
		expect(scanHours(PREVIEW_MAX_SCAN_ROWS * 1000)).toBe(1)
		const sixHours = summarize("logs", rows, sizes, 1, 6)
		expect(sixHours).toMatchObject({
			scannedHours: 6,
			stored: 1550 * 4,
			matched: 500 * 4,
			estimatedDropped: 2000,
		})
	})

	it("lists the services with matches, busiest first", () => {
		expect(summarize("logs", rows, sizes, 0).services).toEqual([
			{ serviceName: "checkout", stored: 1000, matched: 400 },
			{ serviceName: "api", stored: 500, matched: 100 },
		])
		expect(summarize("logs", rows, sizes, 0).estimatedDropped).toBe(0)
	})
})
