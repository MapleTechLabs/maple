import { describe, expect, it } from "vitest"
import { slugFromName } from "./slug"

describe("slugFromName", () => {
	it("keeps accented letters as their base letter instead of splitting them with hyphens", () => {
		expect(slugFromName("Crème Brûlée")).toBe("creme-brulee")
		expect(slugFromName("Über Status")).toBe("uber-status")
	})

	it("collapses punctuation and trims hyphens at the ends", () => {
		expect(slugFromName("  Acme Status! ")).toBe("acme-status")
	})
})
