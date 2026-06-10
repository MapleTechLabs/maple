import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { convertFamiliesToOtlp, toUnixNano, type OtlpMetric, type ScrapeOtlpContext } from "./otlp"
import { parsePrometheusText } from "./parser"

const ctx: ScrapeOtlpContext = {
	targetId: "11111111-1111-4111-8111-111111111111",
	targetName: "Node Exporter",
	serviceName: "node",
	instance: "node.example.com:9100",
	targetLabels: { env: "prod" },
	scrapeTimeMs: 1750000000000,
}

const convert = (body: string) => convertFamiliesToOtlp(parsePrometheusText(body).families, ctx)

const metricByName = (metrics: ReadonlyArray<OtlpMetric>, name: string): OtlpMetric => {
	const metric = metrics.find((m) => m.name === name)
	if (!metric) throw new Error(`metric ${name} not found`)
	return metric
}

const metricsOf = (body: string): ReadonlyArray<OtlpMetric> => {
	const { request } = convert(body)
	if (request === null) throw new Error("expected a request")
	return request.resourceMetrics[0]!.scopeMetrics[0]!.metrics
}

const attrsToRecord = (attributes: ReadonlyArray<{ key: string; value: { stringValue: string } }>) =>
	Object.fromEntries(attributes.map((attr) => [attr.key, attr.value.stringValue]))

describe("toUnixNano", () => {
	it("converts epoch ms to a ns string without float precision loss", () => {
		// 1781077905732 ms * 1e6 = 1.78e18 ns > Number.MAX_SAFE_INTEGER — must
		// be exact, which rules out JS number arithmetic.
		expect(toUnixNano(1781077905732)).toBe("1781077905732000000")
		expect(toUnixNano(0)).toBe("0")
	})
})

describe("convertFamiliesToOtlp", () => {
	it("returns null request for empty scrapes", () => {
		const result = convert("")
		expect(result.request).toBeNull()
		expect(result.dataPointCounts).toEqual({ sum: 0, gauge: 0, histogram: 0 })
	})

	it("sets resource attributes for routing but never org attribution", () => {
		const { request } = convert("# TYPE up gauge\nup 1")
		const attrs = attrsToRecord(request!.resourceMetrics[0]!.resource.attributes)
		expect(attrs).toEqual({
			"service.name": "node",
			maple_scrape_target_id: "11111111-1111-4111-8111-111111111111",
			maple_scrape_target_name: "Node Exporter",
		})
		// The gateway injects maple_org_id from the ingest key and strips any
		// client-supplied value — sending it would be misleading.
		expect(attrs).not.toHaveProperty("maple_org_id")
		expect(request!.resourceMetrics[0]!.scopeMetrics[0]!.scope.name).toBe("maple-prometheus-scraper")
	})

	it("converts counters to cumulative monotonic sums", () => {
		const metrics = metricsOf('# TYPE requests counter\n# HELP requests Total.\nrequests_total{code="200"} 100')
		const metric = metricByName(metrics, "requests_total")
		expect(metric.description).toBe("Total.")
		expect(metric.sum).toBeDefined()
		expect(metric.sum!.aggregationTemporality).toBe(2)
		expect(metric.sum!.isMonotonic).toBe(true)
		const point = metric.sum!.dataPoints[0]!
		expect(point.asDouble).toBe(100)
		expect(point.startTimeUnixNano).toBe("0")
		expect(point.timeUnixNano).toBe(toUnixNano(ctx.scrapeTimeMs))
	})

	it("uses the sample timestamp when present", () => {
		const metrics = metricsOf('# TYPE g gauge\ng{a="1"} 1 1712345678901')
		expect(metricByName(metrics, "g").gauge!.dataPoints[0]!.timeUnixNano).toBe(toUnixNano(1712345678901))
	})

	it("merges target labels and sample labels into data point attributes, system labels win", () => {
		const metrics = metricsOf('# TYPE g gauge\ng{job="evil",instance="evil",env="staging",custom="yes"} 1')
		const attrs = attrsToRecord(metricByName(metrics, "g").gauge!.dataPoints[0]!.attributes)
		expect(attrs).toEqual({
			env: "staging",
			custom: "yes",
			job: "node",
			instance: "node.example.com:9100",
		})
	})

	it("de-cumulates histogram buckets, excludes +Inf from explicitBounds, keeps numeric counts", () => {
		const metrics = metricsOf(
			[
				"# TYPE lat histogram",
				'lat_bucket{le="0.1"} 1',
				'lat_bucket{le="1"} 4',
				'lat_bucket{le="5"} 9',
				'lat_bucket{le="+Inf"} 10',
				"lat_sum 42.5",
				"lat_count 10",
			].join("\n"),
		)
		const metric = metricByName(metrics, "lat")
		expect(metric.histogram!.aggregationTemporality).toBe(2)
		const point = metric.histogram!.dataPoints[0]!
		expect(point.explicitBounds).toEqual([0.1, 1, 5])
		expect(point.bucketCounts).toEqual([1, 3, 5, 1])
		// The gateway's serde expects count/bucketCounts as JSON numbers (NOT
		// the spec's strings) and timeUnixNano as a string — pin both.
		expect(typeof point.count).toBe("number")
		expect(point.bucketCounts.every((count) => typeof count === "number")).toBe(true)
		expect(typeof point.timeUnixNano).toBe("string")
		expect(point.count).toBe(10)
		expect(point.sum).toBe(42.5)
		expect(point.bucketCounts.reduce((a, b) => a + b, 0)).toBe(point.count)
		expect(point.bucketCounts.length).toBe(point.explicitBounds.length + 1)
	})

	it("groups histogram series by label set (minus le) into one metric", () => {
		const metrics = metricsOf(
			[
				"# TYPE lat histogram",
				'lat_bucket{path="/a",le="1"} 2',
				'lat_bucket{path="/a",le="+Inf"} 3',
				'lat_sum{path="/a"} 1.2',
				'lat_count{path="/a"} 3',
				'lat_bucket{path="/b",le="1"} 5',
				'lat_bucket{path="/b",le="+Inf"} 5',
				'lat_sum{path="/b"} 2.5',
				'lat_count{path="/b"} 5',
			].join("\n"),
		)
		const metric = metricByName(metrics, "lat")
		expect(metric.histogram!.dataPoints).toHaveLength(2)
		const byPath = Object.fromEntries(
			metric.histogram!.dataPoints.map((point) => [attrsToRecord(point.attributes).path, point]),
		)
		expect(byPath["/a"]?.count).toBe(3)
		expect(byPath["/a"]?.bucketCounts).toEqual([2, 1])
		expect(byPath["/b"]?.bucketCounts).toEqual([5, 0])
		expect(attrsToRecord(byPath["/a"]!.attributes)).not.toHaveProperty("le")
	})

	it("clamps negative bucket deltas and tolerates a missing _count via the +Inf bucket", () => {
		const clamped = metricsOf(
			["# TYPE a histogram", 'a_bucket{le="1"} 5', 'a_bucket{le="2"} 3', 'a_bucket{le="+Inf"} 5', "a_count 5", "a_sum 1"].join("\n"),
		)
		expect(metricByName(clamped, "a").histogram!.dataPoints[0]!.bucketCounts).toEqual([5, 0, 2])

		const viaInf = metricsOf(["# TYPE b histogram", 'b_bucket{le="1"} 1', 'b_bucket{le="+Inf"} 4', "b_sum 2"].join("\n"))
		expect(metricByName(viaInf, "b").histogram!.dataPoints[0]!.count).toBe(4)

		const incomplete = convert(["# TYPE c histogram", 'c_bucket{le="1"} 1', "c_sum 2"].join("\n"))
		expect(incomplete.request).toBeNull()
		expect(incomplete.droppedSeriesCount).toBe(1)
	})

	it("omits the histogram sum field when the scrape lacks one", () => {
		const metrics = metricsOf(["# TYPE h histogram", 'h_bucket{le="+Inf"} 2', "h_count 2"].join("\n"))
		expect(metricByName(metrics, "h").histogram!.dataPoints[0]).not.toHaveProperty("sum")
	})

	it("degrades summaries: _sum/_count as sums, quantiles as a gauge", () => {
		const metrics = metricsOf(
			["# TYPE rpc summary", 'rpc{quantile="0.5"} 0.05', "rpc_sum 102.1", "rpc_count 800"].join("\n"),
		)
		expect(metricByName(metrics, "rpc_sum").sum!.isMonotonic).toBe(false)
		expect(metricByName(metrics, "rpc_count").sum!.isMonotonic).toBe(true)
		const quantiles = metricByName(metrics, "rpc").gauge!.dataPoints
		expect(attrsToRecord(quantiles[0]!.attributes).quantile).toBe("0.5")
	})

	it("drops non-finite values everywhere and counts them", () => {
		const result = convert(
			[
				"# TYPE c counter",
				"c_total NaN",
				"# TYPE g gauge",
				'g{kind="inf"} +Inf',
				'g{kind="ok"} 1',
				"# TYPE s summary",
				's{quantile="0.5"} NaN',
				"s_count 5",
			].join("\n"),
		)
		expect(result.droppedSeriesCount).toBe(3)
		expect(result.dataPointCounts).toEqual({ sum: 1, gauge: 1, histogram: 0 })
		// The serialized payload must be valid JSON with no NaN/Infinity leakage.
		const roundTripped = JSON.parse(JSON.stringify(result.request)) as unknown
		expect(roundTripped).toEqual(result.request)
	})
})

describe("gateway contract fixture", () => {
	it("matches the checked-in fixture consumed by apps/ingest's scraper_contract Rust test", () => {
		const body = [
			"# HELP http_requests Total requests.",
			"# TYPE http_requests counter",
			'http_requests_total{code="200"} 100',
			"# TYPE up gauge",
			"up 1",
			"# TYPE lat histogram",
			'lat_bucket{le="0.1"} 1',
			'lat_bucket{le="+Inf"} 10',
			"lat_sum 42.5",
			"lat_count 10",
			"# TYPE rpc summary",
			'rpc{quantile="0.5"} 0.05',
			"rpc_sum 102.1",
			"rpc_count 800",
		].join("\n")

		const { request } = convert(body)
		const fixture = JSON.parse(
			readFileSync(join(import.meta.dirname, "__fixtures__", "otlp-export.json"), "utf8"),
		) as unknown

		// If this fails because you changed the converter intentionally,
		// regenerate the fixture AND re-run `cargo test scraper_contract` in
		// apps/ingest — the Rust side deserializes this exact file with the
		// gateway's real serde types.
		expect(request).toEqual(fixture)
	})
})
