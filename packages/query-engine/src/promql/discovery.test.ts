import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { labelNamesFrom, prometheusMetadata } from "./discovery"
import type { CatalogMetric } from "./names"

const metric = (metricType: CatalogMetric["metricType"]): CatalogMetric => ({
	metricName: "http.server.request.duration",
	metricType,
	isMonotonic: metricType === "sum",
	unit: "s",
})

describe("labelNamesFrom", () => {
	it("lists le when an explicit histogram is in the catalog, whose bucket series carry it", () => {
		expect(Arr.contains(labelNamesFrom([metric("histogram")], [], []), "le")).toBe(true)
		expect(
			Arr.contains(labelNamesFrom([metric("sum"), metric("exponential_histogram")], [], []), "le"),
		).toBe(false)
	})
})

describe("prometheusMetadata", () => {
	const row = (unit: string, description: string) => ({
		metricName: "queue.depth",
		metricType: "gauge",
		unit,
		description,
		isMonotonic: 0,
	})

	it("lists every distinct entry of a family once, in row order, instead of keeping one at random", () => {
		const metadata = prometheusMetadata([row("", "Depth"), row("", "Depth"), row("", "Queue depth")])
		expect(metadata.get("queue_depth")).toEqual([
			{ type: "gauge", help: "Depth", unit: "" },
			{ type: "gauge", help: "Queue depth", unit: "" },
		])
	})
})
