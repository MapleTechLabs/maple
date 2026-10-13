import { describe, expect, it } from "vitest"
import { DateTime } from "effect"
import type { CH } from "@maple/query-engine"
import { foldCatalogRows, previewValues } from "./use-local-metrics"

const row = (overrides: Partial<CH.ListMetricsOutput>): CH.ListMetricsOutput => ({
	metricName: "http.server.requests",
	metricType: "sum",
	serviceName: "api",
	metricDescription: "",
	metricUnit: "{request}",
	dataPointCount: 10,
	firstSeen: DateTime.makeUnsafe("2026-07-30T13:00:00Z"),
	lastSeen: DateTime.makeUnsafe("2026-07-30T14:00:00Z"),
	isMonotonic: 1,
	...overrides,
})

describe("foldCatalogRows", () => {
	it("folds per-service rows into one entry spanning the earliest first-seen", () => {
		const { entries, serviceFacets } = foldCatalogRows([
			row({}),
			row({
				serviceName: "worker",
				firstSeen: DateTime.makeUnsafe("2026-07-30T12:00:00Z"),
				dataPointCount: 5,
			}),
		])
		expect(entries).toHaveLength(1)
		expect(entries[0]).toMatchObject({
			serviceNames: ["api", "worker"],
			dataPointCount: 15,
			firstSeen: "2026-07-30T12:00:00.000Z",
			isMonotonic: true,
		})
		expect(serviceFacets).toEqual([
			{ name: "api", count: 1 },
			{ name: "worker", count: 1 },
		])
	})
})

describe("previewValues", () => {
	const points = [
		{ bucket: "b1", avgValue: 100, sumValue: 0, dataPointCount: 1 },
		{ bucket: "b2", avgValue: 130, sumValue: 0, dataPointCount: 1 },
		{ bucket: "b3", avgValue: 10, sumValue: 0, dataPointCount: 1 },
	]

	it("previews a counter's rise per bucket, not its running total", () => {
		expect(previewValues({ metricType: "sum", isMonotonic: true }, points)).toEqual([
			{ bucket: "b2", v: 30 },
			// A reset (the process restarted) is not a negative rate.
			{ bucket: "b3", v: 0 },
		])
	})

	it("previews everything else as the average value", () => {
		expect(previewValues({ metricType: "gauge", isMonotonic: false }, points).map((p) => p.v)).toEqual([
			100, 130, 10,
		])
	})
})
