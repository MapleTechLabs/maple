import { type LabelMatcher, parse } from "@maple/promql"
import { Result } from "effect"
import { describe, expect, it } from "vitest"
import {
	editDistance,
	missingLabelMatchers,
	nearestNames,
	unknownLabelWarning,
	unknownMetricWarning,
} from "./hints"
import { examplePromqlFor, promqlNamesFor } from "./display"
import type { CatalogMetric } from "./names"

const metric = (overrides: Partial<CatalogMetric> & Pick<CatalogMetric, "metricName">): CatalogMetric => ({
	metricType: "gauge",
	isMonotonic: false,
	unit: "",
	...overrides,
})

const duration = metric({ metricName: "http.server.request.duration", metricType: "histogram", unit: "s" })
const requests = metric({ metricName: "http.server.requests", metricType: "sum", isMonotonic: true })
const memory = metric({ metricName: "jvm.memory.used", unit: "By" })
const rpc = metric({ metricName: "rpc.duration", metricType: "exponential_histogram", unit: "ms" })
const CATALOG = [duration, requests, memory, rpc]

describe("editDistance", () => {
	it("counts insertions, deletions and substitutions", () => {
		expect(editDistance("kitten", "sitting")).toBe(3)
		expect(editDistance("", "abc")).toBe(3)
		expect(editDistance("same", "same")).toBe(0)
	})
})

describe("nearestNames", () => {
	it("ranks names sharing tokens and spelling first", () => {
		const names = [
			"http_server_requests_total",
			"jvm_memory_used_bytes",
			"http_client_duration_seconds_count",
		]
		expect(nearestNames("http_requests_total", names)[0]).toBe("http_server_requests_total")
	})

	it("suggests nothing when no name is close", () => {
		expect(nearestNames("zzz", ["http_server_requests_total", "jvm_memory_used_bytes"])).toEqual([])
	})

	it("caps the suggestions", () => {
		const names = ["cpu_a", "cpu_b", "cpu_c", "cpu_d", "cpu_e"]
		expect(nearestNames("cpu_x", names)).toHaveLength(3)
	})
})

describe("unknownMetricWarning", () => {
	it("suggests the nearest Prometheus names", () => {
		const warning = unknownMetricWarning("http_requests_total", CATALOG)
		expect(warning).toContain('no metric named "http_requests_total"')
		expect(warning).toContain('"http_server_requests_total"')
	})

	it("explains an OTel dotted name of a histogram", () => {
		const warning = unknownMetricWarning("http.server.request.duration", CATALOG)
		expect(warning).toContain('"http_server_request_duration_seconds_bucket"')
		expect(warning).toContain("underscores")
	})

	it("explains a histogram read without its suffix", () => {
		const warning = unknownMetricWarning("http_server_request_duration_seconds", CATALOG)
		expect(warning).toContain('"http_server_request_duration_seconds_bucket"')
		expect(warning).toContain("_bucket, _count and _sum")
	})

	it("explains _bucket on an exponential histogram", () => {
		const warning = unknownMetricWarning("rpc_duration_milliseconds_bucket", CATALOG)
		expect(warning).toContain('"rpc_duration_milliseconds_count"')
		expect(warning).toContain("no _bucket series")
	})

	it("explains _total on a gauge", () => {
		expect(unknownMetricWarning("jvm_memory_used_bytes_total", CATALOG)).toContain(
			"only monotonic sums end in _total",
		)
	})

	it("says when the window holds no metrics at all", () => {
		expect(unknownMetricWarning("up", [])).toContain("no metrics were received")
	})
})

describe("labels", () => {
	const eq = (name: string, value: string): LabelMatcher => ({ name, op: "=", value })

	it("keeps only matchers that need an absent label", () => {
		const present = new Set(["__name__", "job"])
		const missing = missingLabelMatchers(
			[eq("__name__", "up"), eq("job", "api"), eq("service_name", "api"), eq("region", "")],
			present,
		)
		expect(missing).toEqual([eq("service_name", "api")])
	})

	it("suggests job for service_name", () => {
		expect(unknownLabelWarning("up", "service_name", ["__name__", "job", "instance"])).toBe(
			'no sampled series of "up" in the query window has a label "service_name"; did you mean "job"?',
		)
	})

	it("suggests near label names", () => {
		expect(unknownLabelWarning("up", "http_status", ["job", "http_response_status_code"])).toContain(
			'"http_response_status_code"',
		)
	})
})

describe("promqlNamesFor and examplePromqlFor", () => {
	const listed = (m: CatalogMetric) => ({ ...m, unit: m.unit })

	it("lists one name per component", () => {
		expect(promqlNamesFor(listed(duration))).toEqual([
			"http_server_request_duration_seconds_bucket",
			"http_server_request_duration_seconds_count",
			"http_server_request_duration_seconds_sum",
		])
		expect(promqlNamesFor({ ...listed(memory), metricType: "summary" })).toEqual([])
	})

	it("selects a reserved name instead of reading it as a number", () => {
		const nan = { metricName: "NaN", metricType: "gauge", isMonotonic: false, unit: "" }
		expect(examplePromqlFor(nan)).toBe('avg by (job) ({"NaN"})')
	})

	it("starts from a rate, a quantile or the value by type", () => {
		expect(examplePromqlFor(listed(requests))).toBe("sum by (job) (rate(http_server_requests_total[5m]))")
		expect(examplePromqlFor(listed(duration))).toBe(
			"histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_seconds_bucket[5m])))",
		)
		expect(examplePromqlFor(listed(memory))).toBe("avg by (job) (jvm_memory_used_bytes)")
		expect(examplePromqlFor(listed(rpc))).toBe(
			"sum(rate(rpc_duration_milliseconds_sum[5m])) / sum(rate(rpc_duration_milliseconds_count[5m]))",
		)
	})
})

describe("example queries parse", () => {
	it("are valid PromQL for reserved and ordinary names", () => {
		const metrics = [
			{ metricName: "NaN", metricType: "gauge", isMonotonic: false, unit: "" },
			{ metricName: "Inf", metricType: "sum", isMonotonic: false, unit: "" },
			{ metricName: "http.server.requests", metricType: "sum", isMonotonic: true, unit: "" },
		]
		for (const metric of metrics) {
			expect(Result.isSuccess(parse(examplePromqlFor(metric) ?? ""))).toBe(true)
		}
	})
})
