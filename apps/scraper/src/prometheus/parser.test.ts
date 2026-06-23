import { describe, expect, it } from "vitest"
import { parsePrometheusText, type PromMetricFamily } from "./parser"

const familyByName = (families: ReadonlyArray<PromMetricFamily>, name: string): PromMetricFamily => {
	const family = families.find((f) => f.name === name)
	if (!family) throw new Error(`family ${name} not found`)
	return family
}

describe("parsePrometheusText", () => {
	it("parses an empty body", () => {
		const result = parsePrometheusText("")
		expect(result.families).toEqual([])
		expect(result.skippedLineCount).toBe(0)
	})

	it("parses a realistic node_exporter style payload", () => {
		const body = [
			"# HELP node_cpu_seconds_total Seconds the CPUs spent in each mode.",
			"# TYPE node_cpu_seconds_total counter",
			'node_cpu_seconds_total{cpu="0",mode="idle"} 312.4',
			'node_cpu_seconds_total{cpu="0",mode="user"} 12.7',
			"# HELP node_memory_bytes Memory information.",
			"# TYPE node_memory_bytes gauge",
			"node_memory_bytes 1.073741824e+09",
			"# HELP http_request_duration_seconds Request latency.",
			"# TYPE http_request_duration_seconds histogram",
			'http_request_duration_seconds_bucket{le="0.1"} 1',
			'http_request_duration_seconds_bucket{le="1"} 4',
			'http_request_duration_seconds_bucket{le="+Inf"} 10',
			"http_request_duration_seconds_sum 12.5",
			"http_request_duration_seconds_count 10",
			"# HELP rpc_duration_seconds RPC latency summary.",
			"# TYPE rpc_duration_seconds summary",
			'rpc_duration_seconds{quantile="0.5"} 0.05',
			'rpc_duration_seconds{quantile="0.99"} 0.2',
			"rpc_duration_seconds_sum 102.1",
			"rpc_duration_seconds_count 800",
			"untyped_thing 42",
		].join("\n")

		const result = parsePrometheusText(body)
		expect(result.skippedLineCount).toBe(0)

		const counter = familyByName(result.families, "node_cpu_seconds_total")
		expect(counter.type).toBe("counter")
		expect(counter.help).toBe("Seconds the CPUs spent in each mode.")
		expect(counter.samples).toHaveLength(2)
		expect(counter.samples[0]).toEqual({
			name: "node_cpu_seconds_total",
			labels: { cpu: "0", mode: "idle" },
			value: 312.4,
			timestampMs: null,
		})

		const gauge = familyByName(result.families, "node_memory_bytes")
		expect(gauge.type).toBe("gauge")
		expect(gauge.samples[0]?.value).toBe(1.073741824e9)
		expect(gauge.samples[0]?.labels).toEqual({})

		const histogram = familyByName(result.families, "http_request_duration_seconds")
		expect(histogram.type).toBe("histogram")
		expect(histogram.samples.map((s) => s.name)).toEqual([
			"http_request_duration_seconds_bucket",
			"http_request_duration_seconds_bucket",
			"http_request_duration_seconds_bucket",
			"http_request_duration_seconds_sum",
			"http_request_duration_seconds_count",
		])

		const summary = familyByName(result.families, "rpc_duration_seconds")
		expect(summary.type).toBe("summary")
		expect(summary.samples).toHaveLength(4)

		const untyped = familyByName(result.families, "untyped_thing")
		expect(untyped.type).toBe("untyped")
		expect(untyped.samples[0]?.value).toBe(42)
	})

	it("handles label escapes, commas and braces inside values, and trailing commas", () => {
		const body = [
			"# TYPE weird gauge",
			'weird{path="C:\\\\temp\\\\f.txt",msg="say \\"hi\\"",multi="a\\nb",comma="x,y{z}",} 1',
		].join("\n")

		const result = parsePrometheusText(body)
		expect(result.skippedLineCount).toBe(0)
		const family = familyByName(result.families, "weird")
		expect(family.samples[0]?.labels).toEqual({
			path: "C:\\temp\\f.txt",
			msg: 'say "hi"',
			multi: "a\nb",
			comma: "x,y{z}",
		})
	})

	it("parses +Inf, -Inf and NaN values", () => {
		const body = [
			"# TYPE extremes gauge",
			'extremes{kind="pos"} +Inf',
			'extremes{kind="neg"} -Inf',
			'extremes{kind="nan"} NaN',
		].join("\n")
		const result = parsePrometheusText(body)
		const family = familyByName(result.families, "extremes")
		expect(family.samples[0]?.value).toBe(Number.POSITIVE_INFINITY)
		expect(family.samples[1]?.value).toBe(Number.NEGATIVE_INFINITY)
		expect(Number.isNaN(family.samples[2]?.value)).toBe(true)
	})

	it("parses optional timestamps (ms for text format, seconds for OpenMetrics)", () => {
		const body = [
			"# TYPE ts_metric gauge",
			'ts_metric{src="prom"} 1 1712345678901',
			'ts_metric{src="om"} 2 1712345678.5',
		].join("\n")
		const result = parsePrometheusText(body)
		const family = familyByName(result.families, "ts_metric")
		expect(family.samples[0]?.timestampMs).toBe(1712345678901)
		expect(family.samples[1]?.timestampMs).toBe(1712345678500)
	})

	it("skips malformed lines without throwing", () => {
		const body = [
			"# TYPE good gauge",
			"good 1",
			'bad{unterminated="x 2',
			"no_value_here",
			"value_not_number abc",
			"good 3 ts-not-a-number",
			"{} 5",
		].join("\n")
		const result = parsePrometheusText(body)
		expect(result.skippedLineCount).toBe(5)
		const family = familyByName(result.families, "good")
		expect(family.samples).toHaveLength(1)
	})

	it("tolerates OpenMetrics constructs: EOF, UNIT, unknown type, exemplars, _total counters, _created", () => {
		const body = [
			"# TYPE http_requests counter",
			"# UNIT http_requests requests",
			"# HELP http_requests Total requests.",
			'http_requests_total{code="200"} 100 # {trace_id="abc123"} 1.0',
			'http_requests_created{code="200"} 1712345678.5',
			"# TYPE mystery unknown",
			"mystery 7",
			"# EOF",
		].join("\n")

		const result = parsePrometheusText(body)
		expect(result.skippedLineCount).toBe(0)

		const counter = familyByName(result.families, "http_requests")
		expect(counter.type).toBe("counter")
		expect(counter.unit).toBe("requests")
		// exemplar suffix stripped, _created dropped
		expect(counter.samples).toHaveLength(1)
		expect(counter.samples[0]).toEqual({
			name: "http_requests_total",
			labels: { code: "200" },
			value: 100,
			timestampMs: null,
		})

		const mystery = familyByName(result.families, "mystery")
		expect(mystery.type).toBe("untyped")
	})

	it("handles CRLF line endings and blank lines", () => {
		const result = parsePrometheusText("# TYPE a gauge\r\n\r\na 1\r\n")
		expect(result.skippedLineCount).toBe(0)
		expect(familyByName(result.families, "a").samples[0]?.value).toBe(1)
	})

	it("drops families that end up with no samples (TYPE/HELP only)", () => {
		const result = parsePrometheusText("# TYPE ghost counter\n# HELP ghost Never emitted.")
		expect(result.families).toEqual([])
	})
})
