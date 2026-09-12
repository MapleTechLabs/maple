import { describe, expect, it } from "vitest"
import { widthFor } from "./investigation-fanout"

describe("widthFor", () => {
	/**
	 * A null severity is unclassified, not unimportant. Error incidents carry no
	 * severity until someone triages them, so treating null as the floor would give
	 * the highest-volume incident kind the thinnest investigations.
	 */
	it("treats an unclassified incident as medium, not as the minimum", () => {
		expect(widthFor(null, "error")).toBe(4)
		expect(widthFor("medium", "error")).toBe(4)
	})

	it("scales with severity", () => {
		expect(widthFor("critical", "error")).toBe(5)
		expect(widthFor("high", "error")).toBe(4)
		expect(widthFor("low", "error")).toBe(3)
	})

	/** An anomaly is already a narrow claim about one signal. */
	it("caps anomalies below the others regardless of severity", () => {
		expect(widthFor("critical", "anomaly")).toBe(3)
	})
})
