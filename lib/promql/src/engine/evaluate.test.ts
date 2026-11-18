import { Array as Arr, Result, String as Str } from "effect"
import { describe, expect, it } from "vitest"
import { buildDataset, DATA_END_MS, DATA_START_MS } from "../../scripts/compliance/dataset"
import { QUERIES } from "../../scripts/compliance/queries"
import { parse } from "../parser"
import {
	evaluate,
	memorySource,
	type QueryParams,
	type QueryResult,
	runQuery,
	type SelectorData,
	type SelectorRequest,
} from "./index"

const dataset = buildDataset()
const bucketed = memorySource(dataset)
const raw = (request: SelectorRequest) => bucketed({ ...request, widthMs: 0, needsValues: true })

const run = (query: string, params: QueryParams, source = bucketed) => {
	const result = runQuery(query, params, source)
	if (Result.isFailure(result)) throw new Error(`${query}: ${result.failure.message}`)
	return result.success
}

const flatten = (result: QueryResult): Array<[string, number, number]> => {
	switch (result.resultType) {
		case "scalar":
			return [["", result.result.t, result.result.v]]
		case "string":
			return []
		case "vector":
			return result.result.map((s) => [JSON.stringify(s.labels), s.t, s.value])
		case "matrix":
			return result.result.flatMap((s) =>
				s.points.map((p): [string, number, number] => [JSON.stringify(s.labels), p.t, p.v]),
			)
	}
}

/** The first point where two results differ, or undefined. */
const mismatch = (
	a: Array<[string, number, number]>,
	b: Array<[string, number, number]>,
): string | undefined => {
	if (a.length !== b.length) return `${a.length} points vs ${b.length}`
	for (const [i, [k, t, v]] of a.entries()) {
		const other = b[i]
		if (other === undefined || other[0] !== k || other[1] !== t) return `point ${i} is ${k}@${t}`
		const w = other[2]
		const equal =
			(Number.isNaN(v) && Number.isNaN(w)) ||
			v === w ||
			(Number.isFinite(v) &&
				Number.isFinite(w) &&
				Math.abs(v - w) <= 1e-9 * Math.max(1, Math.abs(v), Math.abs(w)))
		if (!equal) return `${k}@${t}: ${v} vs ${w}`
	}
	return undefined
}

describe("bucketed evaluation matches raw samples", () => {
	const range = { startMs: DATA_START_MS + 1800_000, endMs: DATA_END_MS - 600_000, stepMs: 60_000 }
	const instant = { startMs: DATA_START_MS + 3600_000, endMs: DATA_START_MS + 3600_000, stepMs: 0 }
	for (const query of QUERIES) {
		it(query, () => {
			expect(mismatch(flatten(run(query, range)), flatten(run(query, range, raw)))).toBeUndefined()
			expect(mismatch(flatten(run(query, instant)), flatten(run(query, instant, raw)))).toBeUndefined()
		})
	}
})

describe("evaluate", () => {
	const at = DATA_START_MS + 3600_000
	const instant = { startMs: at, endMs: at, stepMs: 0 }

	it("reads the latest sample within the lookback", () => {
		const result = run('http_requests_total{instance="c:9090"}', instant)
		expect(result.resultType).toBe("vector")
		expect(flatten(result)).toHaveLength(1)
	})

	it("drops a series whose last sample is older than five minutes", () => {
		// The b:9090 code=500 series has a gap from +30m to +45m.
		const inGap = DATA_START_MS + 2_400_000
		const result = run('http_requests_total{instance="b:9090", code="500"}', {
			startMs: inGap,
			endMs: inGap,
			stepMs: 0,
		})
		expect(flatten(result)).toHaveLength(0)
	})

	it("returns raw samples for a bare range selector", () => {
		const result = run('http_requests_total{instance="a:9090", code="200"}[1m]', instant)
		expect(result.resultType).toBe("matrix")
		// 15s scrape: (t-60s, t] holds four samples.
		expect(flatten(result)).toHaveLength(4)
	})

	it("rejects a range vector in a range query", () => {
		const result = runQuery("x[5m]", { startMs: 0, endMs: 60_000, stepMs: 15_000 }, bucketed)
		expect(Result.isFailure(result)).toBe(true)
	})

	it("enforces the point limit", () => {
		const result = runQuery(
			"http_requests_total",
			{ startMs: DATA_START_MS, endMs: DATA_END_MS, stepMs: 15_000 },
			bucketed,
			{
				maxSeries: 100,
				maxPoints: 1000,
			},
		)
		expect(Result.isFailure(result) && result.failure.message).toMatch(/too many samples/)
	})
})

describe("regex matchers", () => {
	const at = DATA_START_MS + 3600_000
	const instant = { startMs: at, endMs: at, stepMs: 0 }

	it("match case-insensitively and with POSIX classes, as Prometheus does", () => {
		const count = (q: string) => flatten(run(q, instant)).length
		expect(count('http_requests_total{job=~"(?i)API"}')).toBe(count('http_requests_total{job="api"}'))
		expect(count('http_requests_total{instance=~"[[:alpha:]]:9090"}')).toBe(count("http_requests_total"))
		expect(count("http_requests_total")).toBeGreaterThan(0)
	})
})

describe("the first evaluation window", () => {
	// One sample 10m before the first step: inside a 15m range, outside the 5m lookback.
	const M = 60_000
	const start = DATA_START_MS + 3600_000
	const src = memorySource([{ labels: { __name__: "m" }, samples: [[start - 10 * M + 1, 7]] }])
	const steps = [
		{ startMs: start, endMs: start + 15 * M, stepMs: 15 * M },
		{ startMs: start, endMs: start + 15 * M, stepMs: 7 * M },
		{ startMs: start, endMs: start, stepMs: 0 },
	]

	it("counts a sample the range reaches back to, at any step", () => {
		expect(Arr.map(steps, (params) => flatten(run("count_over_time(m[15m])", params, src)))).toEqual(
			Arr.map(steps, () => [["{}", start, 1]]),
		)
	})

	it("leaves it out of a bare selector, whose lookback is 5m", () => {
		expect(Arr.map(steps, (params) => flatten(run("m", params, src)))).toEqual(Arr.map(steps, () => []))
	})
})

describe("explicit instant queries", () => {
	it("read only their start, whatever end the caller passes", () => {
		const requests: Array<SelectorRequest> = []
		const at = DATA_START_MS + 3600_000
		const source = (request: SelectorRequest) => {
			requests.push(request)
			return bucketed(request)
		}
		const wide = run(
			"timestamp(http_requests_total @ end())",
			{ startMs: at, endMs: DATA_END_MS, stepMs: 0, instant: true },
			source,
		)
		const narrow = run("timestamp(http_requests_total @ end())", { startMs: at, endMs: at, stepMs: 0 })
		expect(flatten(wide)).toEqual(flatten(narrow))
		expect(Arr.every(requests, (r) => r.endMs <= at)).toBe(true)
	})
})

describe("resolution limits", () => {
	it("rejects a subquery finer than 11000 points before reading anything", () => {
		let reads = 0
		const counting = (request: SelectorRequest) => {
			reads += 1
			return bucketed(request)
		}
		const result = runQuery(
			"max_over_time(http_requests_total[1y:1ms])",
			{ startMs: DATA_END_MS, endMs: DATA_END_MS, stepMs: 0 },
			counting,
		)
		expect(Result.isFailure(result) && result.failure.message).toMatch(/subquery resolution too fine/)
		expect(reads).toBe(0)
	})
})

describe("top-level resolution", () => {
	const message = (params: QueryParams) => {
		const result = runQuery("vector(1)", params, bucketed)
		return Result.isFailure(result) ? result.failure.message : "ok"
	}

	it("counts intervals like Prometheus: 11000 steps pass, 11001 fail", () => {
		expect(message({ startMs: 0, endMs: 11_000_000, stepMs: 1000 })).toBe("ok")
		expect(message({ startMs: 0, endMs: 11_000_999, stepMs: 1000 })).toBe("ok")
		expect(message({ startMs: 0, endMs: 11_001_000, stepMs: 1000 })).toBe(
			"exceeded maximum resolution of 11,000 points per timeseries. Try decreasing the query resolution (?step=XX)",
		)
	})

	it("rejects a range query with no positive step", () => {
		expect(message({ startMs: 0, endMs: 60_000, stepMs: 0 })).toMatch(
			/zero or negative query resolution step/,
		)
		expect(message({ startMs: 0, endMs: 60_000, stepMs: -1 })).toMatch(
			/zero or negative query resolution step/,
		)
		expect(message({ startMs: 60_000, endMs: 60_000, stepMs: 0 })).toBe("ok")
	})

	it("is enforced by evaluate itself, not only runQuery", () => {
		const parsed = parse("vector(1)")
		if (Result.isFailure(parsed)) throw new Error(parsed.failure.message)
		const result = evaluate({
			expr: parsed.success,
			params: { startMs: 0, endMs: 1_000_000_000_000, stepMs: 1 },
			data: new Map(),
		})
		expect(Result.isFailure(result) && result.failure.message).toMatch(/exceeded maximum resolution/)
	})
})

describe("unary plus", () => {
	it("makes timestamp() read the evaluation time, not the sample time", () => {
		const at = DATA_START_MS + 3600_000 + 7_000
		const instant = { startMs: at, endMs: at, stepMs: 0 }
		const selector = 'http_requests_total{instance="a:9090", code="200"}'
		const values = (q: string) => flatten(run(q, instant)).map(([, , v]) => v)
		expect(values(`timestamp(${selector})`)).toEqual([(DATA_START_MS + 3600_000) / 1000])
		expect(values(`timestamp(+${selector})`)).toEqual([at / 1000])
	})
})

describe("query mode", () => {
	it("returns a one-point matrix for a range query whose start equals its end", () => {
		const t = DATA_START_MS + 3600_000
		const result = run("vector(2)", { startMs: t, endMs: t, stepMs: 30_000, instant: false })
		expect(result).toEqual({ resultType: "matrix", result: [{ labels: {}, points: [{ t, v: 2 }] }] })
	})
})

describe("review regressions", () => {
	const t0 = 1_700_000_000_000
	const at = (s: number) => t0 + s * 1000
	const source = (
		series: ReadonlyArray<{
			labels: Record<string, string>
			samples: ReadonlyArray<readonly [number, number]>
		}>,
	) => memorySource(series)
	const instant = (s: number) => ({ startMs: at(s), endMs: at(s), stepMs: 0 })
	const ok = (query: string, params: QueryParams, src: ReturnType<typeof memorySource>) => {
		const result = runQuery(query, params, src)
		if (Result.isFailure(result)) throw new Error(`${query}: ${result.failure.message}`)
		return result.success
	}

	it("keeps the variance of a large gauge", () => {
		const src = source([
			{
				labels: { __name__: "g" },
				samples: [
					[at(10), 1e9],
					[at(20), 1e9 + 1],
				],
			},
		])
		expect(flatten(ok("stddev_over_time(g[1m])", instant(30), src))[0]?.[2]).toBe(0.5)
		expect(flatten(ok("stdvar_over_time(g[1m])", instant(30), src))[0]?.[2]).toBe(0.25)
	})

	it("returns every raw sample of a parenthesized range selector", () => {
		const samples = [15, 30, 45, 60].map((s): readonly [number, number] => [at(s), s])
		const src = source([{ labels: { __name__: "x" }, samples }])
		expect(flatten(ok("(x[1m])", instant(60), src))).toHaveLength(4)
	})

	it("drops a filtered comparison before checking for duplicate matches", () => {
		const src = source([
			{ labels: { __name__: "a", job: "x", i: "1" }, samples: [[at(10), 0]] },
			{ labels: { __name__: "a", job: "x", i: "2" }, samples: [[at(10), 2]] },
			{ labels: { __name__: "b", job: "x" }, samples: [[at(10), 1]] },
		])
		expect(flatten(ok("a > on(job) b", instant(20), src))).toHaveLength(1)
	})

	it("gives a negated series the evaluation time and rejects duplicate label sets", () => {
		const src = source([
			{ labels: { __name__: "a", job: "x" }, samples: [[at(15), 1]] },
			{ labels: { __name__: "b", job: "x" }, samples: [[at(15), 1]] },
		])
		expect(flatten(ok("timestamp(-a)", instant(20), src))[0]?.[2]).toBe(at(20) / 1000)
		const dup = runQuery('-{__name__=~"a|b"}', instant(20), src)
		expect(Result.isFailure(dup) && dup.failure.message).toMatch(/same labelset/)
	})

	it("budgets live samples, freeing a stage once the next one has consumed it", () => {
		const src = source(
			["a", "b", "c"].map((id) => ({ labels: { __name__: "x", id }, samples: [[at(10), 1]] as const })),
		)
		// Three samples live per stage, six while a stage turns into the next.
		const result = runQuery("-(-x)", instant(20), src, { maxSeries: 10, maxPoints: 6 })
		expect(Result.isSuccess(result)).toBe(true)
	})

	it("charges raw range samples against the point budget", () => {
		const samples = [15, 30, 45, 60].map((s): readonly [number, number] => [at(s), s])
		const result = runQuery("x[1m]", instant(60), source([{ labels: { __name__: "x" }, samples }]), {
			maxSeries: 10,
			maxPoints: 2,
		})
		expect(Result.isFailure(result) && result.failure.message).toMatch(/too many samples/)
	})
})

describe("second-review regressions", () => {
	const t0 = 1_700_000_000_000
	const at = (s: number) => t0 + s * 1000
	const instant = (s: number) => ({ startMs: at(s), endMs: at(s), stepMs: 0 })
	const one = (labels: Record<string, string>, samples: ReadonlyArray<readonly [number, number]>) =>
		memorySource([{ labels: { __name__: "x", ...labels }, samples }])
	const value = (query: string, params: QueryParams, src: ReturnType<typeof memorySource>) => {
		const result = runQuery(query, params, src)
		if (Result.isFailure(result)) throw new Error(result.failure.message)
		return flatten(result.success)[0]?.[2]
	}

	it("charges a range function's raw input against the budget", () => {
		const src = one(
			{},
			[15, 30, 45, 60].map((s): readonly [number, number] => [at(s), s]),
		)
		const result = runQuery("quantile_over_time(0.5, x[1m])", instant(60), src, {
			maxSeries: 10,
			maxPoints: 2,
		})
		expect(Result.isFailure(result) && result.failure.message).toMatch(/too many samples/)
	})

	it("predicts at the step's time even when @ pins the window", () => {
		const src = one({}, [
			[at(10), 10],
			[at(20), 20],
		])
		expect(value("predict_linear(x[20s] @ " + at(20) / 1000 + ", 0)", instant(30), src)).toBeCloseTo(30)
	})

	it("sorts NaN first for quantile_over_time", () => {
		const src = one({}, [
			[at(10), 1],
			[at(20), Number.NaN],
			[at(30), 2],
		])
		expect(value("quantile_over_time(0.75, x[1m])", instant(40), src)).toBe(1.5)
	})

	it("reads an infinite value at a whole rank in quantile_over_time, as the aggregation does", () => {
		const src = one({}, [
			[at(10), 1],
			[at(20), Infinity],
		])
		expect(value("quantile_over_time(0, x[1m])", instant(30), src)).toBe(1)
	})

	it("refuses an invalid smoothing factor instead of returning nothing", () => {
		const src = one({}, [
			[at(10), 1],
			[at(20), 2],
		])
		const result = runQuery("double_exponential_smoothing(x[1m], 0, 0.5)", instant(30), src)
		expect(Result.isFailure(result) && result.failure.message).toMatch(/smoothing factor/)
	})

	it("treats an inherited property name as a missing label", () => {
		const src = one({}, [[at(10), 1]])
		expect(value('x{toString=""}', instant(20), src)).toBe(1)
	})

	it("does not count consecutive NaNs as a change", () => {
		const src = one({}, [
			[at(10), Number.NaN],
			[at(20), Number.NaN],
		])
		expect(value("changes(x[1m])", instant(30), src)).toBe(0)
	})
})

describe("prototype-named labels and the native-histogram functions", () => {
	const at = DATA_START_MS + 3600_000
	const instant = { startMs: at, endMs: at, stepMs: 0 }

	it("reads a label named like an Object member as missing", () => {
		const joined = flatten(
			run('label_join(http_requests_total, "joined", "-", "constructor", "code")', instant),
		)
		expect(joined.length).toBeGreaterThan(0)
		expect(Arr.some(joined, ([key]) => Str.includes("function")(key))).toBe(false)
		expect(
			flatten(run('sort_by_label(http_requests_total, "toString")', instant)).length,
		).toBeGreaterThan(0)
	})

	it("answers histogram_fraction from classic buckets and nothing for float-only functions", () => {
		const fraction = flatten(
			run("histogram_fraction(-Inf, +Inf, http_request_duration_seconds_bucket)", instant),
		)
		expect(fraction.length).toBeGreaterThan(0)
		for (const [, , v] of fraction) expect(v).toBe(1)
		expect(flatten(run("histogram_count(http_request_duration_seconds_bucket)", instant))).toEqual([])
	})
})

describe("prototype-named labels in matching and absent", () => {
	const at = DATA_START_MS + 3600_000
	const instant = { startMs: at, endMs: at, stepMs: 0 }

	it("does not copy an Object member through group_left", () => {
		const result = run(
			"http_requests_total * on(instance) group_left(constructor) group by (instance) (http_requests_total)",
			instant,
		)
		const samples = result.resultType === "vector" ? result.result : []
		expect(samples.length).toBeGreaterThan(0)
		expect(Arr.some(samples, (s) => Object.hasOwn(s.labels, "constructor"))).toBe(false)
	})

	it("keeps an absent() label called __proto__ as a label", () => {
		const result = run('absent(nonexistent{__proto__="x"})', instant)
		expect(result.resultType === "vector" && result.result[0]?.labels).toEqual(
			Object.fromEntries([["__proto__", "x"]]),
		)
	})
})

describe("go-live engine fixes", () => {
	const t0 = 1_700_000_040_000
	const instant = (ms: number) => ({ startMs: ms, endMs: ms, stepMs: 0 })
	const value = (query: string, params = instant(180_000), src = memorySource([])) =>
		flatten(run(query, params, src))[0]?.[2]
	// Values at the subquery steps 60s, 120s and 180s.
	const steps = (a: string, b: string, c: string) =>
		`(vector(${a}) * (time() == bool 60) + vector(${b}) * (time() == bool 120) + vector(${c}) * (time() == bool 180))[3m:1m]`

	it("evaluates negative literals the way Prometheus does", () => {
		expect(value("-2 ^ 2")).toBe(-4)
		expect(value("2 ^ -1")).toBe(0.5)
		expect(value("2 * -3 ^ 2")).toBe(-18)
		expect(value("vector(3) * -1")).toBe(-3)
		expect(value("1 - -1")).toBe(2)
	})

	it("applies an offset after a binary operator to the right operand only", () => {
		const src = memorySource([
			{
				labels: { __name__: "x" },
				samples: [
					[t0, 2],
					[t0 + 60_000, 8],
				],
			},
		])
		expect(value("x / x offset 1m", instant(t0 + 60_000), src)).toBe(4)
	})

	it("sums with Kahan compensation and averages without overflow, as Prometheus 3.5", () => {
		expect(value(`sum_over_time(${steps("1", "-1e16", "1e16")})`)).toBe(1)
		expect(value(`avg_over_time(${steps("1", "-1e16", "1e16")})`)).toBe(1 / 3)
		expect(value("avg_over_time(vector(1e308)[3m:1m])")).toBe(1e308)
		expect(value("sum_over_time(vector(1e308)[3m:1m])")).toBe(Number.POSITIVE_INFINITY)
		expect(value(`avg_over_time(${steps("-1e308", "1e308", "1e308")})`)).toBe(3.333333333333333e307)
		expect(value(`avg_over_time(${steps("1e308", "1e308", "-1e308")})`)).toBe(3.333333333333333e307)
	})

	it("compensates bucket sums so bucket and raw mode agree", () => {
		const src = memorySource([
			{
				labels: { __name__: "g" },
				samples: [
					[t0 + 10_000, 1],
					[t0 + 20_000, -1e16],
					[t0 + 30_000, 1e16],
				],
			},
		])
		const rawSrc = (request: SelectorRequest) => src({ ...request, widthMs: 0, needsValues: true })
		for (const source of [src, rawSrc]) {
			expect(value("sum_over_time(g[1m])", instant(t0 + 40_000), source)).toBe(1)
			expect(value("avg_over_time(g[1m])", instant(t0 + 40_000), source)).toBe(1 / 3)
		}
	})
})

describe("pushed subtrees", () => {
	const pushedRate = (series: number, steps: number, maxPoints: number) => {
		const parsed = parse("rate(x[1m])")
		if (Result.isFailure(parsed)) throw new Error(parsed.failure.message)
		const stepIndexes = Arr.makeBy(steps, (j) => j)
		return evaluate({
			expr: parsed.success,
			params: { startMs: 0, endMs: (steps - 1) * 60_000, stepMs: 60_000 },
			data: new Map(),
			pushed: new Map([
				[
					parsed.success,
					{
						series: Arr.makeBy(series, (i) => ({
							labels: { __name__: "x", id: `${i}` },
							steps: stepIndexes,
							values: stepIndexes,
						})),
					},
				],
			]),
			limits: { maxSeries: 100, maxPoints },
		})
	}

	it("refuses a pushed answer with more samples than the point budget", () => {
		const result = pushedRate(4, 10, 39)
		expect(Result.isFailure(result) && result.failure.message).toMatch(/too many samples/)
	})

	it("accepts a pushed answer that fits the budget exactly", () => {
		expect(Result.isSuccess(pushedRate(4, 10, 40))).toBe(true)
	})
})

describe("fourth-review engine regressions", () => {
	const t0 = 1_700_000_040_000
	const at = (s: number) => t0 + s * 1000
	const both = (src: ReturnType<typeof memorySource>) => [
		src,
		(request: SelectorRequest) => src({ ...request, widthMs: 0, needsValues: true }),
	]
	const first = (query: string, params: QueryParams, src: (r: SelectorRequest) => SelectorData) =>
		flatten(run(query, params, src))[0]?.[2]

	it("computes a counter increase from the endpoints and reset corrections", () => {
		const src = memorySource([
			{
				labels: { __name__: "x" },
				samples: [
					[at(1), 10],
					[at(2), Number.NaN],
					[at(3), 20],
				],
			},
		])
		for (const source of both(src)) {
			expect(first("increase(x[3s])", { startMs: at(3), endMs: at(3), stepMs: 0 }, source)).toBe(15)
		}
	})

	it("keeps each bucket's Kahan compensation when merging bucket sums", () => {
		const src = memorySource([
			{
				labels: { __name__: "g" },
				samples: [
					[at(5), 1e16],
					[at(6), 1],
					[at(15), -1e16],
				],
			},
		])
		const params = { startMs: at(60), endMs: at(70), stepMs: 10_000 }
		for (const source of both(src)) expect(first("sum_over_time(g[1m])", params, source)).toBe(1)
	})

	it("fits a regression on one-sample buckets relative to the intercept, not the window start", () => {
		const week = 604_800_000
		const src = memorySource([
			{
				labels: { __name__: "d" },
				samples: [
					[t0 + week - 2, 0],
					[t0 + week - 1, 1],
				],
			},
		])
		const raw = (request: SelectorRequest) => src({ ...request, widthMs: 0, needsValues: true })
		const params = { startMs: t0 + week, endMs: t0 + week, stepMs: 0 }
		expect(first("deriv(d[1w])", params, raw)).toBeCloseTo(1000, 6)
	})
})
