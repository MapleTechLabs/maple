import { Result } from "effect"
import { describe, expect, it } from "vitest"
import { bucketFraction, histogramQuantile, parseGoFloat } from "./histogram-quantile"
import type { InstantVector } from "./types"

const T = 1_000
const buckets = (
	counts: ReadonlyArray<readonly [string, number]>,
	extra: Record<string, string> = {},
): InstantVector =>
	counts.map(([le, value]) => ({
		labels: { __name__: "lat_bucket", job: "api", le, ...extra },
		value,
		t: 0,
	}))
const q = (phi: number, vector: InstantVector) =>
	Result.getOrThrow(histogramQuantile(phi, vector, T)).map((x) => x.value)

// Cumulative counts: 10 in (0,0.1], 10 in (0.1,0.5], 20 in (0.5,1], 0 above 1.
const basic = buckets([
	["0.1", 10],
	["0.5", 20],
	["1", 40],
	["+Inf", 40],
])

describe("histogramQuantile", () => {
	it("interpolates linearly inside the bucket that holds the rank", () => {
		expect(q(0.5, basic)).toEqual([0.5]) // rank 20 fills (0.1,0.5]: 0.1 + 0.4 * (10/10)
		expect(q(0.75, basic)).toEqual([0.75]) // rank 30: 0.5 + 0.5 * (10/20)
		expect(q(0.25, basic)).toEqual([0.1])
		expect(q(0.125, basic)).toEqual([0.05]) // first bucket starts at 0
	})

	it("drops __name__ and le from the output and groups by the other labels", () => {
		const r = Result.getOrThrow(
			histogramQuantile(
				0.5,
				[
					...basic,
					...buckets(
						[
							["1", 1],
							["+Inf", 1],
						],
						{ job: "web" },
					),
				],
				T,
			),
		)
		expect(r.map((x) => x.labels)).toEqual([{ job: "api" }, { job: "web" }])
	})

	it("returns the upper bound of the last finite bucket for ranks in +Inf", () => {
		expect(
			q(
				0.99,
				buckets([
					["1", 1],
					["+Inf", 10],
				]),
			),
		).toEqual([1])
	})

	it("uses the lowest bound itself when it is <= 0", () => {
		expect(
			q(
				0.1,
				buckets([
					["-1", 5],
					["0", 8],
					["+Inf", 10],
				]),
			),
		).toEqual([-1])
	})

	it("is NaN without a +Inf bucket, without observations, or for a NaN phi", () => {
		expect(q(0.5, buckets([["1", 5]]))).toEqual([Number.NaN])
		expect(
			q(
				0.5,
				buckets([
					["1", 0],
					["+Inf", 0],
				]),
			),
		).toEqual([Number.NaN])
		expect(q(Number.NaN, basic)).toEqual([Number.NaN])
	})

	it("phi outside [0, 1] gives -Inf or +Inf", () => {
		expect(q(-0.1, basic)).toEqual([-Infinity])
		expect(q(1.1, basic)).toEqual([Infinity])
	})

	it("forces non-monotonic buckets to be monotonic", () => {
		// The 0.5 bucket dips below 0.1; Prometheus raises it to 10, so rank 10 resolves in the first bucket.
		expect(
			q(
				0.5,
				buckets([
					["0.1", 10],
					["0.5", 5],
					["1", 20],
					["+Inf", 20],
				]),
			),
		).toEqual([0.1])
	})

	it("skips samples whose le does not parse", () => {
		expect(q(0.5, [...basic, ...buckets([["bogus", 1000]])])).toEqual([0.5])
	})
})

describe("parseGoFloat", () => {
	it("accepts the spellings strconv.ParseFloat accepts", () => {
		expect(["+Inf", "inf", "-Infinity", "1e3", ".5", "2."].map(parseGoFloat)).toEqual([
			Infinity,
			Infinity,
			-Infinity,
			1000,
			0.5,
			2,
		])
		expect(["", "abc", "1,5"].map(parseGoFloat)).toEqual([undefined, undefined, undefined])
	})
})

describe("bucketFraction", () => {
	const cumulative = [
		{ upperBound: 0.1, count: 10 },
		{ upperBound: 0.5, count: 20 },
		{ upperBound: 1, count: 40 },
		{ upperBound: Infinity, count: 40 },
	]

	it("starts positive buckets at 0, so a range inside the first bucket interpolates", () => {
		expect(bucketFraction(0, 0.2, cumulative)).toBeCloseTo(12.5 / 40) // 10 + 10 * (0.1/0.4)
		expect(bucketFraction(0, 0.05, cumulative)).toBeCloseTo(5 / 40)
	})

	it("counts a whole infinite-width first bucket instead of answering NaN", () => {
		const negative = [
			{ upperBound: -1, count: 4 },
			{ upperBound: 1, count: 8 },
			{ upperBound: Infinity, count: 8 },
		]
		expect(bucketFraction(-2, 0, negative)).toBeCloseTo(2 / 8) // 4 at -2, 6 at 0
	})
})
