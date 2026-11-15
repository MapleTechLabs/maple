import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { labelNamesFrom } from "./discovery"
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
