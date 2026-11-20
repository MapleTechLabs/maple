import type { LabelMatcher } from "@maple/promql"
import { describe, expect, it } from "vitest"
import {
	editDistance,
	missingLabelMatchers,
	nearestNames,
	unknownLabelWarning,
	unknownMetricWarning,
} from "./hints"
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
			'no series of "up" has a label "service_name"; did you mean "job"?',
		)
	})

	it("suggests near label names", () => {
		expect(unknownLabelWarning("up", "http_status", ["job", "http_response_status_code"])).toContain(
			'"http_response_status_code"',
		)
	})
})
