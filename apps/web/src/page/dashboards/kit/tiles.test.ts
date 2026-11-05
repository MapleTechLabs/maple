import { describe, expect, it } from "vitest"
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
		expect(listCellText("solo")).toBe(formatCell("solo"))
		expect(listCellText(null)).toBe(formatCell(null))
	})
})
