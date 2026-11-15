import type { QueryResult } from "@maple/promql"
import { Array as Arr, Record as Rec } from "effect"
import { describe, expect, it } from "vitest"
import { formatPromqlLegend, promqlRowsForDisplay, promqlStepSeconds } from "./rows"

const t0 = Date.UTC(2026, 0, 1)
const iso = (offsetS: number) => new Date(t0 + offsetS * 1000).toISOString()

const webSeries = {
	labels: { __name__: "up", job: "web", instance: "b" },
	points: [
		{ t: t0, v: 1 },
		{ t: t0 + 60_000, v: 0 },
	],
}

const matrix: QueryResult = {
	resultType: "matrix",
	result: [
		webSeries,
		{
			labels: { __name__: "up", job: "api", instance: "a" },
			points: [
				{ t: t0, v: 1 },
				{ t: t0 + 60_000, v: Number.NaN },
			],
		},
	],
}

describe("formatPromqlLegend", () => {
	const labels = { __name__: "up", job: "api", instance: "a" }

	it("prints the label set when there is no format", () => {
		expect(formatPromqlLegend(labels)).toBe('up{instance="a", job="api"}')
		expect(formatPromqlLegend({ job: "api" }, "  ")).toBe('{job="api"}')
	})

	it("fills {{label}} and leaves a missing label empty", () => {
		expect(formatPromqlLegend(labels, "{{job}} on {{ instance }} {{zone}}")).toBe("api on a ")
	})
})

describe("promqlRowsForDisplay", () => {
	it("draws a line chart as one wide row per step, a column per series", () => {
		expect(promqlRowsForDisplay(matrix, { displayType: "line", legendFormat: "{{job}}" })).toEqual([
			{ bucket: iso(0), api: 1, web: 1 },
			{ bucket: iso(60), web: 0 },
		])
	})

	it("reads an absent display type as a line chart and numbers repeated names", () => {
		const rows = promqlRowsForDisplay(matrix, { legendFormat: "{{__name__}}" })
		expect(rows[0]).toEqual({ bucket: iso(0), up: 1, "up (2)": 1 })
	})

	it("never lets a legend name take the time column", () => {
		const rows = promqlRowsForDisplay(matrix, { legendFormat: "bucket" })
		expect(rows[0]).toEqual({ bucket: iso(0), "bucket (2)": 1, "bucket (3)": 1 })
	})

	it("gives a stat the first series, newest point first", () => {
		const rows = promqlRowsForDisplay(matrix, { displayType: "stat" })
		expect(rows).toEqual([{ bucket: iso(0), value: 1 }])
		const web = promqlRowsForDisplay(
			{ resultType: "matrix", result: [webSeries] },
			{ displayType: "stat" },
		)
		expect(web).toEqual([
			{ bucket: iso(60), value: 0 },
			{ bucket: iso(0), value: 1 },
		])
	})

	it("keeps a series label called name or value beside the row's own columns", () => {
		const sshd = {
			resultType: "vector" as const,
			result: [{ labels: { __name__: "unit", name: "sshd", value: "x" }, value: 1, t: 0 }],
		}
		expect(promqlRowsForDisplay(sshd, { displayType: "table", legendFormat: "{{name}}" })).toEqual([
			{ __name__: "unit", label_name: "sshd", label_value: "x", name: "sshd", value: 1 },
		])
	})

	it("moves a name label past an existing label_name instead of overwriting it", () => {
		const both = {
			resultType: "vector" as const,
			result: [{ labels: { name: "sshd", label_name: "original" }, value: 1, t: 0 }],
		}
		expect(promqlRowsForDisplay(both, { displayType: "table", legendFormat: "x" })).toEqual([
			{ label_name: "original", label_label_name: "sshd", name: "x", value: 1 },
		])
	})

	it("keeps a series whose legend is __proto__ as a column", () => {
		const rows = promqlRowsForDisplay(matrix, { displayType: "line", legendFormat: "__proto__" })
		expect(rows.length).toBeGreaterThan(0)
		expect(Arr.some(rows, (row) => Rec.has(row, "__proto__"))).toBe(true)
		expect(Arr.every(rows, (row) => Object.getPrototypeOf(row) === Object.prototype)).toBe(true)
	})

	it("gives a table one row per series with its labels and last value", () => {
		expect(promqlRowsForDisplay(matrix, { displayType: "table", legendFormat: "{{job}}" })).toEqual([
			{ __name__: "up", job: "web", instance: "b", name: "web", value: 0 },
		])
	})

	it("reads vectors and scalars", () => {
		const vector: QueryResult = {
			resultType: "vector",
			result: [{ labels: { job: "api" }, value: 3, t: t0 }],
		}
		expect(promqlRowsForDisplay(vector, { displayType: "stat" })).toEqual([{ bucket: iso(0), value: 3 }])
		expect(promqlRowsForDisplay(vector, { displayType: "pie" })).toEqual([
			{ job: "api", name: '{job="api"}', value: 3 },
		])
		const scalar: QueryResult = { resultType: "scalar", result: { t: t0, v: 2 } }
		expect(promqlRowsForDisplay(scalar, { displayType: "bar" })).toEqual([{ bucket: iso(0), scalar: 2 }])
	})
})

describe("promqlStepSeconds", () => {
	const hour = { startMs: 0, endMs: 3_600_000 }

	it("aims at about 200 points on a round step", () => {
		expect(promqlStepSeconds(hour)).toBe(30)
		expect(promqlStepSeconds({ startMs: 0, endMs: 7 * 86_400_000 })).toBe(3600)
	})

	it("follows the tile width within 100 to 300 points", () => {
		expect(promqlStepSeconds({ ...hour, maxDataPoints: 1000 })).toBe(15)
		expect(promqlStepSeconds({ startMs: 0, endMs: 86_400_000, maxDataPoints: 20 })).toBe(900)
	})

	it("never goes under the min step, 15s by default", () => {
		expect(promqlStepSeconds({ startMs: 0, endMs: 600_000 })).toBe(15)
		expect(promqlStepSeconds({ startMs: 0, endMs: 600_000, minStepSeconds: 5 })).toBe(5)
		expect(promqlStepSeconds({ ...hour, minStepSeconds: 300 })).toBe(300)
	})
})
