import { Array as Arr, String as Str } from "effect"
import { describe, expect, it } from "vitest"
import { completionContextAt, onlyMetricOf, promqlParseError } from "./promql-complete"
import {
	DISCOVERY_PAGE,
	EMPTY_DISCOVERY,
	discoveryKey,
	discoveryRequestsFor,
	suggestionsFor,
} from "./promql-suggest"

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
			quote: '"',
		})
		expect(at("up{job=~|")).toMatchObject({ kind: "labelValue", label: "job", quote: null })
		expect(at('{"service.name"="ap|')).toMatchObject({
			kind: "labelValue",
			label: "service.name",
			metric: null,
		})
		expect(at('{"http\\u002eserver", |')).toMatchObject({ kind: "labelName", metric: "http.server" })
		expect(at('{"http.server.duration", |')).toMatchObject({
			kind: "labelName",
			metric: "http.server.duration",
		})
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

describe("onlyMetricOf", () => {
	it("names the one metric a query selects, skipping functions, aggregations and grouping labels", () => {
		expect(onlyMetricOf("sum by (job) (rate(http_requests_total[5m]))")).toBe("http_requests_total")
		expect(onlyMetricOf('sum(rate({"http.server.duration"}[1m]))')).toBe("http.server.duration")
	})

	it("names none when the query selects several metrics or none", () => {
		expect(onlyMetricOf("up or sum by (job) (http_requests_total)")).toBeNull()
		expect(onlyMetricOf('{job="a"}')).toBeNull()
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
		expect(promqlParseError("up * 1.e2 + 1.e-2")).toBeNull()
	})

	it("reads a variable followed by a unit as a number", () => {
		expect(promqlParseError("rate(up[${__interval_ms}ms])")).toBeNull()
	})

	it("keeps offsets after a lone $: the error inside the half-typed variable is the server's", () => {
		expect(promqlParseError("sum(x[$]) +* 2")).toBeNull()
		expect(promqlParseError("sum(x[$a]) +* 2")).toMatchObject({
			from: 12,
			message: 'syntax error near "*"',
		})
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

	it("keeps an exact function name, since the pick adds its parenthesis", () => {
		const labels = Arr.map(
			suggestionsFor({ kind: "expression", from: 0, prefix: "rate" }, EMPTY_DISCOVERY, []),
			(s) => s.insert,
		)
		expect(labels[0]).toBe("rate(")
	})

	it("quotes a picked label value, or escapes it for the quotes the caret is inside", () => {
		const base = { kind: "labelValue", from: 0, prefix: "", metric: "up", label: "job" } as const
		const [request] = discoveryRequestsFor({ ...base, quote: null }, EMPTY_DISCOVERY)
		expect(request).toEqual({ label: "job", match: '{__name__="up"}' })
		const discovery = { entries: { [discoveryKey(request ?? {})]: ['a"b\\c'] }, requested: [] }
		const insertFor = (quote: string | null) =>
			suggestionsFor({ ...base, quote }, discovery, [])[0]?.insert
		expect(insertFor(null)).toBe('"a\\"b\\\\c"')
		expect(insertFor('"')).toBe('a\\"b\\\\c')
		expect(insertFor("'")).toBe('a"b\\\\c')
	})

	it("writes UTF-8 metric and label names quoted", () => {
		const metrics = {
			entries: { [discoveryKey({ label: "__name__" })]: ["http.server.duration"] },
			requested: [],
		}
		const metric = suggestionsFor({ kind: "expression", from: 0, prefix: "http" }, metrics, [])[0]
		expect(metric?.insert).toBe('{"http.server.duration"}')
		const labels = { entries: { [discoveryKey({})]: ["service.name", "job"] }, requested: [] }
		const inserts = Arr.map(
			suggestionsFor({ kind: "labelName", from: 0, prefix: "", metric: null }, labels, []),
			(s) => s.insert,
		)
		expect(inserts).toEqual(['"service.name"', "job"])
	})

	it("asks the server for the typed prefix once a full page of metrics leaves names out", () => {
		const context = { kind: "expression", from: 0, prefix: "zebra_r" } as const
		const page = { label: "__name__" }
		expect(discoveryRequestsFor(context, EMPTY_DISCOVERY)).toEqual([page])
		const full = {
			entries: { [discoveryKey(page)]: Arr.makeBy(DISCOVERY_PAGE, (i) => `metric_${i}`) },
			requested: [],
		}
		const requests = discoveryRequestsFor(context, full)
		expect(requests).toEqual([page, { label: "__name__", match: '{__name__=~"zebra_r.*"}' }])
		const found = {
			...full,
			entries: { ...full.entries, [discoveryKey(requests[1] ?? {})]: ["zebra_requests_total"] },
		}
		expect(suggestionsFor(context, found, [])[0]?.label).toBe("zebra_requests_total")
	})

	it("offers built-in and dashboard variables in a range", () => {
		const offered = suggestionsFor({ kind: "duration", from: 0, prefix: "$" }, EMPTY_DISCOVERY, [
			"window",
		])
		const labels = Arr.map(offered, (s) => s.label)
		expect(labels).toEqual(["$__rate_interval", "$__interval", "$__range", "$window"])
	})
})
