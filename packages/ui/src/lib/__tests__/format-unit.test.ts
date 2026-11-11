import { describe, expect, it } from "vitest"
import { formatValueByUnit } from "../format"

describe("formatValueByUnit", () => {
	it("percent expects a 0–1 fraction and scales it by 100", () => {
		expect(formatValueByUnit(0.042, "percent")).toBe("4.2%")
	})

	it("percent_100 expects 0–100 and does not scale", () => {
		expect(formatValueByUnit(4.2, "percent_100")).toBe("4.2%")
	})

	/**
	 * A chart fence carrying 0–1 fractions under a `percent` unit normalises onto
	 * `percent_100`, so every tick and the readout above them arrived here as a
	 * hundredth of a percent — and `toFixed(1)` rendered each of them `0.0%`. The
	 * axis then said the series was flat zero.
	 */
	it("never renders a non-zero rate as a flat 0.0%", () => {
		expect(formatValueByUnit(0.031, "percent_100")).toBe("0.031%")
		expect(formatValueByUnit(0.0031, "percent_100")).toBe("0.0031%")
		expect(formatValueByUnit(0.00031, "percent")).toBe("0.031%")
		expect(formatValueByUnit(0, "percent_100")).toBe("0.0%")
	})

	it("the two percent tokens are 100x apart on the same input", () => {
		expect(formatValueByUnit(0.5, "percent")).toBe("50.0%")
		expect(formatValueByUnit(0.5, "percent_100")).toBe("0.5%")
	})

	it("an uncatalogued unit renders as a bare number — the failure mode this catalog guards", () => {
		expect(formatValueByUnit(1234, "GB")).toBe(formatValueByUnit(1234, undefined))
	})
})
