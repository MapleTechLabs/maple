import { Result } from "effect"
import { describe, expect, it } from "vitest"
import { instantFunction, natsortLess } from "./instant-functions"
import type { InstantVector, Labels } from "./types"

const T = 9_000
const s = (labels: Labels, value: number, t = 0) => ({ labels, value, t })
const call = (func: string, vector: InstantVector, params: ReadonlyArray<number | string> = []) =>
	instantFunction(func, vector, params, T)
const values = (func: string, xs: ReadonlyArray<number>, params: ReadonlyArray<number | string> = []) =>
	Result.getOrThrow(
		call(
			func,
			xs.map((x, i) => s({ i: String(i) }, x)),
			params,
		),
	).map((x) => x.value)
const errorOf = (r: ReturnType<typeof call>) => (Result.isFailure(r) ? r.failure.message : "succeeded")

describe("math functions", () => {
	it("drop __name__ and apply the float function", () => {
		expect(Result.getOrThrow(call("abs", [s({ __name__: "m", a: "1" }, -2)]))).toEqual([
			{ labels: { a: "1" }, value: 2, t: T },
		])
		expect(values("sgn", [-3, 0, 4])).toEqual([-1, 0, 1])
		expect(values("deg", [Math.PI])).toEqual([180])
		expect(values("ln", [-1])).toEqual([Number.NaN])
	})

	it("fail when dropping the name collides two series", () => {
		expect(errorOf(call("abs", [s({ __name__: "a" }, 1), s({ __name__: "b" }, 2)]))).toBe(
			"vector cannot contain metrics with the same labelset",
		)
	})

	it("round uses floor(v*inv + 0.5)/inv, so halves round up", () => {
		expect(values("round", [2.5, -2.5, 1.24])).toEqual([3, -2, 1])
		expect(values("round", [1.26, 7], [0.5])).toEqual([1.5, 7])
	})

	it("clamp, clamp_min and clamp_max", () => {
		expect(values("clamp", [-5, 5, 50], [0, 10])).toEqual([0, 5, 10])
		expect(values("clamp", [1, 2], [10, 0])).toEqual([])
		expect(values("clamp_min", [1, 7], [5])).toEqual([5, 7])
		expect(values("clamp_max", [1, 7], [5])).toEqual([1, 5])
	})

	it("timestamp returns the sample time in seconds", () => {
		expect(Result.getOrThrow(call("timestamp", [s({ __name__: "m" }, 0, 1_500)]))).toEqual([
			{ labels: {}, value: 1.5, t: T },
		])
	})
})

describe("date functions", () => {
	// 2024-02-29T13:45:00Z, a Thursday in a leap year.
	const leap = Date.UTC(2024, 1, 29, 13, 45) / 1000

	it("read the value as unix seconds in UTC", () => {
		const read = (func: string) => values(func, [leap + 0.9])[0]
		expect(
			[
				"year",
				"month",
				"day_of_month",
				"day_of_week",
				"day_of_year",
				"days_in_month",
				"hour",
				"minute",
			].map(read),
		).toEqual([2024, 2, 29, 4, 60, 29, 13, 45])
	})

	it("truncate toward zero like Go's int64()", () => {
		expect(values("hour", [-0.5])).toEqual([0])
		expect(values("minute", [-0.5])).toEqual([0])
		expect(values("hour", [-3601])).toEqual([22])
		expect(values("year", [-1])).toEqual([1969])
		expect(values("day_of_week", [-1])).toEqual([3])
	})

	it("compute dates past JavaScript Date's range, as Prometheus 3.5 returns them", () => {
		const read = (func: string) => values(func, [1e13])[0]
		expect(
			["year", "month", "day_of_month", "day_of_week", "day_of_year", "days_in_month"].map(read),
		).toEqual([318857, 5, 20, 0, 140, 31])
		expect(values("year", [-1e13])).toEqual([-314918])
		expect(values("day_of_year", [-1e13])).toEqual([225])
		expect(values("year", [1e19, Number.POSITIVE_INFINITY, Number.NaN])).toEqual([
			292277026596, 292277026596, 1970,
		])
		expect(values("day_of_year", [1735603200])).toEqual([366])
	})
})

describe("label_replace and label_join", () => {
	const v = [s({ __name__: "up", service: "api-server", zone: "eu" }, 1)]

	it("expands $1 and ${name} from an anchored match and keeps the name", () => {
		const r = Result.getOrThrow(
			call("label_replace", v, ["short", "$1-${rest}", "service", "(\\w+)-(?P<rest>.*)"]),
		)
		expect(r[0]?.labels).toEqual({
			__name__: "up",
			service: "api-server",
			zone: "eu",
			short: "api-server",
		})
	})

	it("leaves the series alone when the regex does not match the whole value", () => {
		const r = Result.getOrThrow(call("label_replace", v, ["short", "x", "service", "api"]))
		expect(r[0]?.labels).toEqual(v[0]?.labels)
	})

	it("an empty replacement deletes the label", () => {
		const r = Result.getOrThrow(call("label_replace", v, ["zone", "", "zone", ".*"]))
		expect(r[0]?.labels).toEqual({ __name__: "up", service: "api-server" })
	})

	it("reports invalid regexes and label names like Prometheus", () => {
		expect(errorOf(call("label_replace", v, ["dst", "", "src", "("]))).toBe(
			"invalid regular expression in label_replace(): (",
		)
		expect(errorOf(call("label_replace", v, ["", "", "src", ".*"]))).toBe(
			"invalid destination label name in label_replace(): ",
		)
	})

	it("label_join joins source values with the separator", () => {
		const r = Result.getOrThrow(call("label_join", v, ["both", "/", "zone", "missing", "service"]))
		expect(r[0]?.labels.both).toBe("eu//api-server")
	})
})

describe("sorting", () => {
	const v = [s({ i: "a10" }, 3), s({ i: "a9" }, Number.NaN), s({ i: "b" }, 1), s({ i: "a2" }, 2)]
	const ids = (r: ReturnType<typeof call>) => Result.getOrThrow(r).map((x) => x.labels.i)

	it("sort and sort_desc put NaN last", () => {
		expect(ids(call("sort", v))).toEqual(["b", "a2", "a10", "a9"])
		expect(ids(call("sort_desc", v))).toEqual(["a10", "a2", "b", "a9"])
	})

	it("sort_by_label uses natural ordering", () => {
		expect(ids(call("sort_by_label", v, ["i"]))).toEqual(["a2", "a9", "a10", "b"])
		expect(ids(call("sort_by_label_desc", v, ["i"]))).toEqual(["b", "a10", "a9", "a2"])
		expect(natsortLess("x2", "x10")).toBe(true)
		expect(natsortLess("x10", "x2")).toBe(false)
	})
})

describe("unsupported functions", () => {
	it("fail instead of guessing", () => {
		expect(errorOf(call("rate", []))).toBe("function rate is not supported on instant vectors")
	})
})
