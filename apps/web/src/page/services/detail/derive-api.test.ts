import { describe, expect, test } from "vitest"
import {
	apiKpis,
	knownStatusMix,
	latencyHistogram,
	kpiSparks,
	matchesFilter,
	responseRows,
	routeList,
	slowestEndpoint,
	statusCodeSummaries,
} from "./derive-api"
import type { ApiBucket, ApiTotals, Endpoint, StatusRow } from "./model-tabs"

const endpoint = (spanName: string, patch: Partial<Endpoint> = {}): Endpoint => ({
	spanName,
	method: "POST",
	route: spanName.slice(spanName.indexOf(" ") + 1),
	spanCount: 100,
	estimatedSpanCount: 100,
	errorCount: 0,
	estimatedErrorCount: 0,
	errorRate: 0,
	avgDurationMs: 5,
	p50DurationMs: 1,
	p95DurationMs: 20,
	p99DurationMs: 50,
	httpClassifiedSpanCount: 100,
	httpStatusCount: 100,
	http4xxCount: 0,
	http5xxCount: 0,
	requestBodyBytes: 0,
	requestBodyCount: 0,
	...patch,
})

const totals = (patch: Partial<ApiTotals> = {}): ApiTotals => ({
	spanCount: 1_000,
	estimatedSpanCount: 20_000,
	httpClassifiedSpanCount: 1_000,
	httpStatusCount: 1_000,
	http4xxCount: 250,
	http5xxCount: 10,
	requestBodyBytes: 2_000_000,
	requestBodyCount: 1_000,
	p50DurationMs: 1,
	p95DurationMs: 30,
	p99DurationMs: 80,
	...patch,
})

const status = (spanName: string, code: string, errorType: string, count: number): StatusRow => ({
	spanName,
	httpStatusCode: code,
	errorType,
	spanCount: count,
	estimatedSpanCount: count,
})

describe("status mix", () => {
	test("rows sealed before the status counters read as unknown, not as zero errors", () => {
		expect(
			knownStatusMix({
				httpClassifiedSpanCount: 0,
				httpStatusCount: 0,
				http4xxCount: 0,
				http5xxCount: 0,
			}),
		).toBeNull()
	})

	test("splits the responses that carried a status code", () => {
		expect(
			knownStatusMix({
				httpClassifiedSpanCount: 10,
				httpStatusCount: 8,
				http4xxCount: 2,
				http5xxCount: 2,
			}),
		).toEqual({
			ok: 0.5,
			client: 0.25,
			server: 0.25,
		})
	})
})

describe("KPIs", () => {
	test("scales stored body bytes by the sampling weight and compares p95 with the previous window", () => {
		const kpis = apiKpis(totals(), totals({ p95DurationMs: 40 }), 100)
		expect(kpis.requestsPerSecond).toBe(200)
		expect(kpis.bytesPerSecond).toBe((2_000_000 * 20) / 100)
		expect(kpis.avgBodyBytes).toBe(2_000)
		expect(kpis.p95Change).toBeCloseTo(-0.25)
	})

	test("an empty previous window gives no p95 change, and no body sizes give no byte rate", () => {
		const kpis = apiKpis(
			totals({ requestBodyCount: 0, requestBodyBytes: 0 }),
			totals({ spanCount: 0 }),
			100,
		)
		expect(kpis.p95Change).toBeNull()
		expect(kpis.bytesPerSecond).toBeNull()
	})
})

describe("non-2xx breakdown", () => {
	const rows = [
		status("POST /v1/traces", "200", "", 600),
		status("POST /v1/traces", "402", "billing_limit", 300),
		status("POST /v1/logs", "402", "billing_limit", 40),
		status("POST /v1/logs", "401", "auth", 10),
		status("POST /v1/blob", "503", "", 50),
	]

	test("leaves 2xx out and ranks codes by count with their share of every non-2xx response", () => {
		const summaries = statusCodeSummaries(rows)
		expect(summaries.map((summary) => [summary.code, summary.count])).toEqual([
			["402", 340],
			["503", 50],
			["401", 10],
		])
		expect(summaries[0]?.share).toBeCloseTo(0.85)
	})

	test("keeps the error.type and routes of each code, empty error types dropped", () => {
		const [top, server] = statusCodeSummaries(rows)
		expect(top?.errorTypes).toEqual([{ name: "billing_limit", count: 340 }])
		expect(routeList(top?.routes ?? [])).toBe("/v1/traces, /v1/logs")
		expect(server?.errorTypes).toEqual([])
	})

	test("route lists past two name how many more", () => {
		expect(
			routeList([
				{ name: "POST /a", count: 3 },
				{ name: "POST /b", count: 2 },
				{ name: "POST /c", count: 1 },
			]),
		).toBe("/a, /b +1")
	})
})

describe("table filters", () => {
	const quiet = endpoint("POST /quiet")
	const rejecting = endpoint("POST /rejecting", { http4xxCount: 6 })
	const slow = endpoint("POST /slow", { p95DurationMs: 400 })

	test("rejecting keeps endpoints answering more than 5% non-2xx", () => {
		expect([quiet, rejecting, slow].filter((row) => matchesFilter(row, "rejecting", ""))).toEqual([
			rejecting,
		])
	})

	test("slow keeps p95 above 100ms, and the search matches the span name case-insensitively", () => {
		expect([quiet, rejecting, slow].filter((row) => matchesFilter(row, "slow", ""))).toEqual([slow])
		expect([quiet, rejecting, slow].filter((row) => matchesFilter(row, "all", "QUI"))).toEqual([quiet])
	})

	test("the slowest badge goes to the worst p95 only once it is past the slow line", () => {
		expect(slowestEndpoint([quiet, slow])).toBe("POST /slow")
		expect(slowestEndpoint([quiet])).toBeNull()
	})
})

describe("latency histogram", () => {
	const levels = [0.01, 0.5, 0.95, 0.99, 0.999]

	test("the bins hold every request between the lowest and highest quantile", () => {
		const bins = latencyHistogram(levels, [0.1, 1, 30, 70, 120])
		expect(bins).toHaveLength(10)
		expect(bins.reduce((sum, bin) => sum + bin.share, 0)).toBeCloseTo(1)
	})

	test("a bimodal endpoint puts most requests in the fast bins and colours the tail by percentile", () => {
		const bins = latencyHistogram(levels, [0.03, 0.4, 29, 72, 125])
		const fastShare = bins.filter((bin) => bin.toMs <= 1).reduce((sum, bin) => sum + bin.share, 0)
		expect(fastShare).toBeGreaterThan(0.5)
		expect(bins[0]?.band).toBe("p50")
		expect(bins[bins.length - 1]?.band).toBe("p99")
	})

	test("a single value has no distribution to draw", () => {
		expect(latencyHistogram(levels, [5, 5, 5, 5, 5])).toEqual([])
	})
})

describe("responses chart rows", () => {
	const bucket = (patch: Partial<ApiBucket>): ApiBucket => ({
		bucket: "2026-10-24T03:00:00.000Z",
		spanName: "",
		estimatedSpanCount: 600,
		httpClassifiedSpanCount: 30,
		httpStatusCount: 30,
		http4xxCount: 6,
		http5xxCount: 3,
		requestBodyBytes: 0,
		p50DurationMs: 1,
		p95DurationMs: 2,
		p99DurationMs: 3,
		...patch,
	})

	test("splits each bucket's request rate by status class", () => {
		expect(responseRows([bucket({})], 60).map((row) => [row.attributeValue, row.value])).toEqual([
			["2xx", 7],
			["4xx", 2],
			["5xx", 1],
		])
	})

	test("a bucket sealed before the status counters is unknown, not 2xx", () => {
		expect(responseRows([bucket({ httpClassifiedSpanCount: 0, httpStatusCount: 0 })], 60)).toEqual([
			{ bucket: "2026-10-24T03:00:00.000Z", attributeValue: "unknown", value: 10 },
		])
	})
})

test("out-of-order t-digest quantiles never give a bin a negative share", () => {
	const bins = latencyHistogram([0.1, 0.5, 0.9, 0.99], [1, 5, 4, 40])
	expect(bins.every((bin) => bin.share >= 0)).toBe(true)
})

test("a bucket the service was silent in reads 0 on the spark, not a gap", () => {
	const bucket = (iso: string, estimatedSpanCount: number): ApiBucket => ({
		bucket: iso,
		spanName: "",
		estimatedSpanCount,
		httpClassifiedSpanCount: 1,
		httpStatusCount: 1,
		http4xxCount: 0,
		http5xxCount: 0,
		requestBodyBytes: 0,
		p50DurationMs: 1,
		p95DurationMs: 1,
		p99DurationMs: 1,
	})
	const sparks = kpiSparks([bucket("2026-10-24T03:00:00.000Z", 60), bucket("2026-10-24T03:03:00.000Z", 120)], 60)
	expect(sparks.requests).toEqual([1, 0, 0, 2])
})
