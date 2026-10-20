import { describe, expect, test } from "vitest"
import { groupByOptionsOf, parseMetricSelection, scrollOverflowOf, seriesKeysOf, toRunPoints } from "./derive"
import { searchOf } from "./flags"

describe("query builder lab derivations", () => {
	test("run points keep the bucket and the finite numeric series only", () => {
		const points = toRunPoints([{ bucket: "2026-10-01 11:00:00", A: 3, B: "4.5", C: "n/a" }])
		expect(points).toEqual([{ bucket: "2026-10-01 11:00:00", series: { A: 3, B: 4.5 } }])
	})

	test("the table shows at most six series, in first-seen order", () => {
		const series = Object.fromEntries(["a", "b", "c", "d", "e", "f", "g"].map((key) => [key, 1]))
		expect(seriesKeysOf([{ bucket: "x", series }])).toEqual(["a", "b", "c", "d", "e", "f"])
	})

	test("traces group by span attributes, header attributes excluded; other sources do not", () => {
		const keys = ["http.route", "http.request.header.cookie", "http.response.header.etag"]
		expect(groupByOptionsOf("traces", keys)).toEqual([
			"service.name",
			"span.name",
			"status.code",
			"http.method",
			"none",
			"attr.http.route",
		])
		expect(groupByOptionsOf("logs", keys)).toEqual(["service.name", "severity", "none"])
	})

	test("a metric selection needs a name and a known type", () => {
		expect(parseMetricSelection("latency::gauge")).toEqual({ metricName: "latency", metricType: "gauge" })
		expect(parseMetricSelection("latency::summary")).toBeNull()
		expect(parseMetricSelection("::gauge")).toBeNull()
	})

	test("the scrollbar thumb scales the track by the visible share, as Base UI measures it", () => {
		expect(scrollOverflowOf({ clientHeight: 832, scrollHeight: 1401 })).toEqual({
			endPx: 569,
			thumbHeightPx: (824 * 832) / 1401,
		})
		expect(scrollOverflowOf({ clientHeight: 832, scrollHeight: 832 })).toBeUndefined()
	})

	test("the URL search keeps only the window fields that are set", () => {
		expect(searchOf("?timePreset=6h&startTime=&tab=x")).toEqual({ timePreset: "6h" })
	})
})
