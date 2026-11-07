import { describe, expect, it } from "vitest"
import { EMPTY_VALUE, formatValueByUnit } from "@maple/ui/lib/format"
import { formatCell, listCellText } from "./tiles"

describe("listCellText", () => {
	it("formats object items instead of printing [object Object]", () => {
		const text = listCellText([{ name: "api" }, "web"])
		expect(text).not.toContain("[object Object]")
		expect(text).toContain("api")
		expect(text).toMatch(/, web$/)
	})

	it("joins primitives and leaves missing items empty", () => {
		expect(listCellText(["a", 1, true, null, undefined])).toBe("a, 1, true, , ")
	})

	it("formats a non-array value like any other cell", () => {
		expect(listCellText("solo")).toBe("solo")
		expect(listCellText(null)).toBe(EMPTY_VALUE)
	})
})

describe("formatCell", () => {
	it("trims float noise from a unitless measure", () => {
		expect(formatCell(0.1 + 0.2)).toBe("0.3")
		expect(formatCell(1234567.891)).toBe("1,234,567.89")
		expect(formatCell(0.004567891)).toBe("0.00457")
		expect(formatCell(1234.5)).toBe("1234.5")
	})

	it("keeps small integers and every string exactly as they came", () => {
		expect(formatCell(200)).toBe("200")
		expect(formatCell("3.10")).toBe("3.10")
		expect(formatCell("18446744073709551615")).toBe("18446744073709551615")
		expect(formatCell("GET /users/{id}")).toBe("GET /users/{id}")
	})

	it("groups a large integer measure", () => {
		expect(formatCell(4687400)).toBe("4,687,400")
	})

	it("still formats a cell that has a unit by its unit", () => {
		expect(formatCell(0.25, "percent")).toBe(formatValueByUnit(0.25, "percent"))
	})
})
