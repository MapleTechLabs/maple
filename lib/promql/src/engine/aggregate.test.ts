import { Result } from "effect"
import { describe, expect, it } from "vitest"
import type { AggregateOp } from "../ast"
import { aggregate, formatFloat } from "./aggregate"
import type { InstantVector, Labels } from "./types"

const T = 5_000
const s = (labels: Labels, value: number) => ({ labels, value, t: 0 })
const input = [
	s({ __name__: "m", job: "a", i: "1" }, 1),
	s({ __name__: "m", job: "a", i: "2" }, 3),
	s({ __name__: "m", job: "b", i: "1" }, 10),
]
const run = (
	op: AggregateOp,
	vector: InstantVector,
	grouping: ReadonlyArray<string> = [],
	without = false,
	param?: number | string,
) => aggregate(op, vector, { grouping, without, param, evalTimeMs: T })
const values = (op: AggregateOp, vector: InstantVector, param?: number | string) =>
	Result.getOrThrow(run(op, vector, [], false, param)).map((x) => x.value)

describe("aggregate grouping", () => {
	it("by keeps only the listed labels, in first-seen group order", () => {
		expect(Result.getOrThrow(run("sum", input, ["job"]))).toEqual([
			{ labels: { job: "a" }, value: 4, t: T },
			{ labels: { job: "b" }, value: 10, t: T },
		])
	})

	it("without drops the listed labels and __name__", () => {
		expect(Result.getOrThrow(run("max", input, ["i"], true))).toEqual([
			{ labels: { job: "a" }, value: 3, t: T },
			{ labels: { job: "b" }, value: 10, t: T },
		])
	})

	it("no grouping collapses to one empty-labelled sample", () => {
		expect(Result.getOrThrow(run("count", input))).toEqual([{ labels: {}, value: 3, t: T }])
	})
})

describe("aggregate operators", () => {
	const v = (...xs: number[]) => xs.map((x, i) => s({ i: String(i) }, x))

	it("sum, avg, group, min and max", () => {
		expect(values("sum", v(1, 2, 3.5))).toEqual([6.5])
		expect(values("avg", v(1, 2, 3, 4))).toEqual([2.5])
		expect(values("group", v(7, 9))).toEqual([1])
		expect(values("min", v(Number.NaN, 4, 2))).toEqual([2]) // NaN only wins when every value is NaN
		expect(values("max", v(Number.NaN, Number.NaN))).toEqual([Number.NaN])
	})

	it("avg switches to an incremental mean instead of overflowing", () => {
		expect(values("avg", v(Number.MAX_VALUE, Number.MAX_VALUE))).toEqual([Number.MAX_VALUE])
		expect(values("avg", v(Infinity, 1))).toEqual([Infinity])
		expect(values("avg", v(Infinity, -Infinity))).toEqual([Number.NaN])
	})

	it("sum uses Kahan compensation", () => {
		expect(values("sum", v(1e100, 1, -1e100))).toEqual([1])
	})

	it("stdvar and stddev are population statistics", () => {
		expect(values("stdvar", v(2, 4, 4, 4, 5, 5, 7, 9))).toEqual([4])
		expect(values("stddev", v(2, 4, 4, 4, 5, 5, 7, 9))).toEqual([2])
		expect(values("stddev", v(1, Infinity))).toEqual([Number.NaN])
	})

	it("quantile interpolates between ranks and clamps phi to +-Inf", () => {
		expect(values("quantile", v(1, 2, 3, 4), 0.5)).toEqual([2.5])
		expect(values("quantile", v(10, 0, 20), 0.75)).toEqual([15])
		expect(values("quantile", v(1, 2), -1)).toEqual([-Infinity])
		expect(values("quantile", v(1, 2), 2)).toEqual([Infinity])
		expect(values("quantile", v(1, 2), Number.NaN)).toEqual([Number.NaN])
	})
})

describe("topk and bottomk", () => {
	const v = [s({ i: "a" }, 5), s({ i: "b" }, Number.NaN), s({ i: "c" }, 1), s({ i: "d" }, 9)]
	const ids = (r: ReturnType<typeof run>) => Result.getOrThrow(r).map((x) => x.labels.i)

	it("keep full labels, order best first and rank NaN last", () => {
		expect(ids(run("topk", v, [], false, 2))).toEqual(["d", "a"])
		expect(ids(run("bottomk", v, [], false, 2))).toEqual(["c", "a"])
		expect(ids(run("topk", v, [], false, 10))).toEqual(["d", "a", "c", "b"])
	})

	it("truncate k, return nothing for k < 1 and fail on NaN", () => {
		expect(ids(run("topk", v, [], false, 1.9))).toEqual(["d"])
		expect(ids(run("topk", v, [], false, 0))).toEqual([])
		const nan = run("topk", v, [], false, Number.NaN)
		expect(Result.isFailure(nan) && nan.failure.message).toBe("Parameter value is NaN")
	})

	it("select per group", () => {
		expect(Result.getOrThrow(run("topk", input, ["job"], false, 1)).map((x) => x.labels)).toEqual([
			{ __name__: "m", job: "a", i: "2" },
			{ __name__: "m", job: "b", i: "1" },
		])
	})
})

describe("count_values", () => {
	it("counts per formatted value and keeps grouping labels", () => {
		const v = [s({ job: "a" }, 1), s({ job: "a" }, 1), s({ job: "b" }, 0.5)]
		expect(Result.getOrThrow(run("count_values", v, ["job"], false, "val"))).toEqual([
			{ labels: { job: "a", val: "1" }, value: 2, t: T },
			{ labels: { job: "b", val: "0.5" }, value: 1, t: T },
		])
	})

	it("fails on an invalid label name", () => {
		const r = run("count_values", [s({}, 1)], [], false, "")
		expect(Result.isFailure(r) && r.failure.message).toBe('invalid label name ""')
	})

	it("formats like strconv.FormatFloat(v, 'f', -1, 64)", () => {
		expect([1e21, 1.5e-7, -0.0001, 123.456, Infinity, -Infinity, Number.NaN].map(formatFloat)).toEqual([
			"1000000000000000000000",
			"0.00000015",
			"-0.0001",
			"123.456",
			"+Inf",
			"-Inf",
			"NaN",
		])
	})
})

describe("experimental aggregations", () => {
	it("limitk and limit_ratio are refused", () => {
		const r = run("limitk", input, [], false, 1)
		expect(Result.isFailure(r) && r.failure.message).toBe("experimental aggregation not supported")
	})
})

describe("topk ties follow Prometheus' heap", () => {
	it("evicts the heap root, so the later of two tied samples survives", () => {
		const s = (id: string, value: number) => ({ labels: { id }, value, t: 0 })
		// Prometheus 3.5 on the same input keeps b and the 0.74 sample.
		const input = [s("a", 0.614), s("b", 0.614), s("c", 0.19), s("d", 0.74)]
		const result = aggregate("topk", input, { grouping: [], without: false, param: 2, evalTimeMs: 0 })
		expect(Result.isSuccess(result) && result.success.map((x) => x.labels.id)).toEqual(["d", "b"])
	})
})
