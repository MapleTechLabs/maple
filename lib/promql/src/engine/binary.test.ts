import { Result } from "effect"
import { describe, expect, it } from "vitest"
import type { VectorMatching } from "../ast"
import { scalarBinary, vectorScalarBinary, vectorVectorBinary } from "./binary"
import type { InstantVector, Labels } from "./types"

const T = 1_000
const s = (labels: Labels, value: number) => ({ labels, value, t: 0 })
const ok = (result: Result.Result<InstantVector, { readonly message: string }>): InstantVector =>
	Result.getOrThrow(result)
const errorOf = (result: Result.Result<InstantVector, { readonly message: string }>): string =>
	Result.isFailure(result) ? result.failure.message : "succeeded"
const on = (labels: ReadonlyArray<string>, extra: Partial<VectorMatching> = {}): VectorMatching => ({
	card: "one-to-one",
	on: true,
	labels,
	include: [],
	...extra,
})

describe("scalarBinary", () => {
	it("follows Go float semantics for %, / and ^", () => {
		expect(scalarBinary("%", -7, 3, false)).toBe(-1) // math.Mod keeps the dividend's sign
		expect(scalarBinary("%", 5, 0, false)).toBeNaN()
		expect(scalarBinary("/", 1, 0, false)).toBe(Infinity)
		expect(scalarBinary("/", 0, 0, false)).toBeNaN()
		expect(scalarBinary("^", 1, Number.NaN, false)).toBe(1) // math.Pow(1, y) = 1
		expect(scalarBinary("^", -1, Infinity, false)).toBe(1)
		expect(scalarBinary("atan2", 1, 1, false)).toBeCloseTo(Math.PI / 4)
	})

	it("comparisons between scalars return 0 or 1", () => {
		expect(scalarBinary(">", 2, 1, true)).toBe(1)
		expect(scalarBinary("==", Number.NaN, Number.NaN, true)).toBe(0)
	})
})

describe("vectorScalarBinary", () => {
	const v = [s({ __name__: "m", a: "1" }, 1), s({ __name__: "m", a: "2" }, 5)]

	it("arithmetic drops the metric name", () => {
		expect(vectorScalarBinary("*", v, 2, false, false, T)).toEqual([
			{ labels: { a: "1" }, value: 2, t: T },
			{ labels: { a: "2" }, value: 10, t: T },
		])
		expect(vectorScalarBinary("-", v, 10, true, false, T).map((x) => x.value)).toEqual([9, 5])
	})

	it("filter comparisons keep the vector sample, name and value, even with the scalar on the left", () => {
		expect(vectorScalarBinary(">", v, 2, false, false, T)).toEqual([
			{ labels: { __name__: "m", a: "2" }, value: 5, t: T },
		])
		// 2 < m keeps m's samples above 2, with m's own value.
		expect(vectorScalarBinary("<", v, 2, true, false, T)).toEqual([
			{ labels: { __name__: "m", a: "2" }, value: 5, t: T },
		])
	})

	it("bool comparisons return 0/1 for every sample and drop the name", () => {
		expect(vectorScalarBinary(">", v, 2, false, true, T)).toEqual([
			{ labels: { a: "1" }, value: 0, t: T },
			{ labels: { a: "2" }, value: 1, t: T },
		])
	})
})

describe("vectorVectorBinary", () => {
	const lhs = [s({ __name__: "a", job: "x", i: "1" }, 10), s({ __name__: "a", job: "y", i: "1" }, 20)]
	const rhs = [s({ __name__: "b", job: "x", i: "1" }, 2), s({ __name__: "b", job: "z", i: "1" }, 3)]

	it("matches one-to-one on all labels but the name by default", () => {
		expect(ok(vectorVectorBinary("/", lhs, rhs, undefined, false, T))).toEqual([
			{ labels: { job: "x", i: "1" }, value: 5, t: T },
		])
	})

	it("on() reduces the result to the matching labels", () => {
		expect(ok(vectorVectorBinary("-", lhs, rhs, on(["job"]), false, T))).toEqual([
			{ labels: { job: "x" }, value: 8, t: T },
		])
	})

	it("comparison filters keep the lhs value and name, bool returns 0/1 without the name", () => {
		expect(ok(vectorVectorBinary(">", lhs, rhs, undefined, false, T))).toEqual([
			{ labels: { __name__: "a", job: "x", i: "1" }, value: 10, t: T },
		])
		expect(ok(vectorVectorBinary("<", lhs, rhs, undefined, true, T))).toEqual([
			{ labels: { job: "x", i: "1" }, value: 0, t: T },
		])
	})

	it("fails on duplicate series on the one side with Prometheus' message", () => {
		const dupRhs = [s({ job: "x", i: "1" }, 1), s({ job: "x", i: "2" }, 2)]
		expect(errorOf(vectorVectorBinary("+", lhs, dupRhs, on(["job"]), false, T))).toBe(
			'found duplicate series for the match group {job="x"} on the right hand-side of the operation: ' +
				'[{i="1", job="x"}, {i="2", job="x"}];many-to-many matching not allowed: matching labels must be unique on one side',
		)
	})

	it("fails when many lhs series match one rhs series without group_left", () => {
		const many = [s({ job: "x", i: "1" }, 1), s({ job: "x", i: "2" }, 2)]
		expect(errorOf(vectorVectorBinary("+", many, [s({ job: "x" }, 1)], on(["job"]), false, T))).toBe(
			"multiple matches for labels: many-to-one matching must be explicit (group_left/group_right)",
		)
	})

	it("group_left keeps the many side's labels and copies include labels from the one side", () => {
		const many = [
			s({ __name__: "req", job: "x", path: "/a" }, 4),
			s({ __name__: "req", job: "x", path: "/b" }, 6),
		]
		const one = [s({ __name__: "info", job: "x", version: "v2" }, 1)]
		expect(
			ok(
				vectorVectorBinary(
					"*",
					many,
					one,
					on(["job"], { card: "many-to-one", include: ["version"] }),
					false,
					T,
				),
			),
		).toEqual([
			{ labels: { job: "x", path: "/a", version: "v2" }, value: 4, t: T },
			{ labels: { job: "x", path: "/b", version: "v2" }, value: 6, t: T },
		])
	})

	it("group_right swaps sides but still computes lhs op rhs", () => {
		const one = [s({ job: "x" }, 100)]
		const many = [s({ job: "x", path: "/a" }, 4)]
		expect(
			ok(vectorVectorBinary("-", one, many, on(["job"], { card: "one-to-many" }), false, T)),
		).toEqual([{ labels: { job: "x", path: "/a" }, value: 96, t: T }])
	})

	it("set operators match by signature", () => {
		const names = (v: InstantVector) => v.map((x) => `${x.labels.__name__}/${x.labels.job}`)
		expect(names(ok(vectorVectorBinary("and", lhs, rhs, undefined, false, T)))).toEqual(["a/x"])
		expect(names(ok(vectorVectorBinary("unless", lhs, rhs, undefined, false, T)))).toEqual(["a/y"])
		expect(names(ok(vectorVectorBinary("or", lhs, rhs, undefined, false, T)))).toEqual([
			"a/x",
			"a/y",
			"b/z",
		])
		expect(
			names(
				ok(
					vectorVectorBinary(
						"and",
						lhs,
						rhs,
						{ card: "many-to-many", on: true, labels: ["i"], include: [] },
						false,
						T,
					),
				),
			),
		).toEqual(["a/x", "a/y"])
	})

	it("rejects results that collapse to the same label set", () => {
		const many = [s({ __name__: "a", job: "x" }, 1), s({ __name__: "b", job: "x" }, 2)]
		expect(
			errorOf(
				vectorVectorBinary(
					"+",
					many,
					[s({ job: "x" }, 1)],
					on(["job"], { card: "many-to-one" }),
					false,
					T,
				),
			),
		).toBe("multiple matches for labels: grouping labels must ensure unique matches")
	})
})

describe("bool comparisons with group_left(__name__)", () => {
	it("drop the metric name after copying the group labels, as Prometheus' VectorBinop", () => {
		const lhs = [s({ __name__: "a", job: "x", i: "1" }, 2)]
		const rhs = [s({ __name__: "b", job: "x" }, 1)]
		const matching = on(["job"], { card: "many-to-one", include: ["__name__"] })
		expect(ok(vectorVectorBinary(">", lhs, rhs, matching, true, T))).toEqual([
			{ labels: { job: "x", i: "1" }, value: 1, t: T },
		])
		expect(ok(vectorVectorBinary("+", lhs, rhs, matching, false, T))[0]?.labels).toEqual({
			__name__: "b",
			job: "x",
			i: "1",
		})
	})
})
