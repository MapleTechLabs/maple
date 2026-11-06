import { describe, expect, it } from "vitest"

import { cacheHitRows, errorShareRows, latencyRows, zoneSignalTotals } from "./zone-signals"

const status = (bucket: string, statusClass: string, requests: number) => ({ bucket, statusClass, requests })
const cache = (bucket: string, cacheStatus: string, requests: number) => ({ bucket, cacheStatus, requests })

describe("zoneSignalTotals", () => {
	it("reports a 4xx-dominated zone as such even when 5xx is zero", () => {
		const totals = zoneSignalTotals(
			[status("t1", "2xx", 6), status("t1", "4xx", 94), status("t1", "5xx", 0)],
			[],
		)
		expect(totals.requests).toBe(100)
		expect(totals.clientErrorRate).toBeCloseTo(0.94)
		expect(totals.serverErrorRate).toBe(0)
	})

	it("measures cache hits over cacheable traffic only", () => {
		const totals = zoneSignalTotals(
			[],
			[cache("t1", "none", 940), cache("t1", "hit", 54), cache("t1", "miss", 6)],
		)
		expect(totals.cacheHitRate).toBeCloseTo(0.9)
		expect(totals.cacheableShare).toBeCloseTo(0.06)
	})

	it("has no cache hit rate when nothing was cacheable", () => {
		expect(zoneSignalTotals([], [cache("t1", "dynamic", 10)]).cacheHitRate).toBeNull()
	})
})

describe("errorShareRows", () => {
	it("splits each bucket into 4xx and 5xx shares and skips empty buckets", () => {
		const rows = errorShareRows([status("t1", "2xx", 3), status("t1", "4xx", 1), status("t2", "2xx", 0)])
		expect(rows).toEqual([
			{ bucket: "t1", attributeValue: "4xx", value: 0.25 },
			{ bucket: "t1", attributeValue: "5xx", value: 0 },
		])
	})
})

describe("cacheHitRows", () => {
	it("skips buckets where nothing was cacheable rather than plotting a zero", () => {
		const rows = cacheHitRows([cache("t1", "hit", 3), cache("t1", "expired", 1), cache("t2", "none", 50)])
		expect(rows).toEqual([{ bucket: "t1", attributeValue: "", value: 0.75 }])
	})
})

describe("latencyRows", () => {
	it("is empty when the plan exposes no quantiles", () => {
		const zero = {
			bucket: "t1",
			ttfbP50Ms: 0,
			ttfbP95Ms: 0,
			ttfbP99Ms: 0,
			originP50Ms: 0,
			originP95Ms: 0,
			originP99Ms: 0,
		}
		expect(latencyRows([zero])).toEqual([])
	})
})
