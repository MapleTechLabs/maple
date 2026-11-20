import { Array as Arr, String as Str } from "effect"
import { describe, expect, it } from "vitest"
import { completionContextAt, firstMetricOf, promqlParseError } from "./promql-complete"
import { EMPTY_DISCOVERY, discoveryKey, discoveryRequestFor, suggestionsFor } from "./promql-suggest"

/** The context with the caret where `|` sits. */
const at = (marked: string) => {
	const [before, after = ""] = Str.split(marked, "|")
	return completionContextAt(before + after, before.length)
}

describe("completionContextAt", () => {
	it("completes metrics and functions at the start and inside a call", () => {
		expect(at("htt|")).toEqual({ kind: "expression", from: 0, prefix: "htt" })
		expect(at("sum(rate(http_req|")).toEqual({ kind: "expression", from: 9, prefix: "http_req" })
	})

	it("completes label names inside braces, scoped to the metric before them", () => {
		expect(at("http_requests_total{|")).toEqual({
			kind: "labelName",
			from: 20,
			prefix: "",
			metric: "http_requests_total",
		})
		expect(at('up{job="api", ins|')).toEqual({ kind: "labelName", from: 14, prefix: "ins", metric: "up" })
		expect(at("{ser|")).toEqual({ kind: "labelName", from: 1, prefix: "ser", metric: null })
	})

	it("completes label values for the label and metric of the matcher", () => {
		expect(at('up{job="ap|')).toEqual({
			kind: "labelValue",
			from: 8,
			prefix: "ap",
			metric: "up",
			label: "job",
			isQuoted: true,
		})
		expect(at("up{job=~|")).toMatchObject({ kind: "labelValue", label: "job", isQuoted: false })
		expect(at('up{job="api"|')).toBeNull()
	})

	it("completes label names after by ( from the aggregated metric", () => {
		expect(at("sum by (|) (rate(http_requests_total[5m]))")).toEqual({
			kind: "labelName",
			from: 8,
			prefix: "",
			metric: "http_requests_total",
		})
	})

	it("completes keywords after a complete expression and durations in a range", () => {
		expect(at("up |")).toEqual({ kind: "operator", from: 3, prefix: "" })
		expect(at("sum(up) o|")).toEqual({ kind: "operator", from: 8, prefix: "o" })
		expect(at("rate(up[|")).toEqual({ kind: "duration", from: 8, prefix: "" })
		expect(at("rate(up[$__ra|")).toEqual({ kind: "variable", from: 8, prefix: "$__ra" })
	})

	it("offers nothing in a comment or right after a metric with no space", () => {
		expect(at("up # note|")).toBeNull()
		expect(at("1|")).toBeNull()
	})
})

describe("firstMetricOf", () => {
	it("skips functions, aggregations and grouping labels", () => {
		expect(firstMetricOf("sum by (job) (rate(http_requests_total[5m]))")).toBe("http_requests_total")
		expect(firstMetricOf("sum(rate(x[1m]))")).toBe("x")
		expect(firstMetricOf('{job="a"}')).toBeNull()
	})
})

describe("promqlParseError", () => {
	it("accepts valid queries, with variables standing in as valid tokens", () => {
		expect(promqlParseError("sum by (job) (rate(http_requests_total[$__rate_interval]))")).toBeNull()
		expect(promqlParseError('up{job="$job"} offset $shift')).toBeNull()
		expect(promqlParseError("")).toBeNull()
	})

	it("points at the token the parser stopped on", () => {
		const error = promqlParseError("sum(rate(up[5m])) +* 2")
		expect(error?.message).toContain("syntax error")
		expect(error).toMatchObject({ from: 19 })
	})

	it("leaves type errors to the server and reads Prometheus' trailing-dot numbers", () => {
		expect(promqlParseError("rate(up)")).toBeNull()
		expect(promqlParseError("up * 1.")).toBeNull()
	})

	it("reports an unclosed matcher at the end of the input", () => {
		expect(promqlParseError('up{job="api"')).toMatchObject({ message: "unexpected end of input" })
	})
})

describe("suggestionsFor", () => {
	it("ranks names starting with the prefix first and drops what does not match", () => {
		const context = { kind: "expression", from: 0, prefix: "rat" } as const
		const discovery = {
			entries: { [discoveryKey({ label: "__name__" })]: ["ratio_total", "http_rate", "up"] },
			requested: [],
		}
		const labels = Arr.map(suggestionsFor(context, discovery, []), (s) => s.label)
		expect(labels.slice(0, 2)).toEqual(["ratio_total", "rate"])
		expect(labels).toContain("http_rate")
		expect(labels).not.toContain("up")
	})

	it("quotes a picked label value unless the caret is inside quotes", () => {
		const base = { kind: "labelValue", from: 0, prefix: "", metric: "up", label: "job" } as const
		const request = discoveryRequestFor({ ...base, isQuoted: false })
		expect(request).toEqual({ label: "job", match: '{__name__="up"}' })
		const discovery = { entries: { [discoveryKey(request ?? {})]: ['a"b'] }, requested: [] }
		expect(suggestionsFor({ ...base, isQuoted: false }, discovery, [])[0]?.insert).toBe('"a\\"b"')
		expect(suggestionsFor({ ...base, isQuoted: true }, discovery, [])[0]?.insert).toBe('a"b')
	})

	it("offers built-in and dashboard variables in a range", () => {
		const offered = suggestionsFor({ kind: "duration", from: 0, prefix: "$" }, EMPTY_DISCOVERY, [
			"window",
		])
		const labels = Arr.map(offered, (s) => s.label)
		expect(labels).toEqual(["$__rate_interval", "$__interval", "$__range", "$window"])
	})
})
