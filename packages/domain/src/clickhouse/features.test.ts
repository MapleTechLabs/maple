import { describe, expect, it } from "vitest"
import { clickHouseSchemaFeatures, clickHouseVersionAtLeast, featureSupportedByVersion } from "./features"
import { Array as Arr } from "effect"

describe("ClickHouse schema features", () => {
	it("compares stable and suffixed ClickHouse versions", () => {
		expect(clickHouseVersionAtLeast("26.2.1.12", "26.2.0")).toBe(true)
		expect(clickHouseVersionAtLeast("26.2.0-beta", "26.2.0")).toBe(true)
		expect(clickHouseVersionAtLeast("26.1.9", "26.2.0")).toBe(false)
	})

	it("keeps text indexes version-gated without automatic legacy backfills", () => {
		const text = clickHouseSchemaFeatures.find((feature) => feature.id === "search_text_v1")!

		expect(featureSupportedByVersion(text, "24.8.12")).toBe(false)
		expect(featureSupportedByVersion(text, "26.2.0")).toBe(true)
		expect(Arr.join(text.statements, "\n")).toContain("TYPE text(tokenizer = 'array')")
		expect(Arr.join(text.statements, "\n")).not.toContain("MATERIALIZE")
		expect(
			Arr.some(clickHouseSchemaFeatures, (feature) => feature.id === "logs_time_projection_v1"),
		).toBe(false)
	})
})
