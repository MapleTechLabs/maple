import { describe, expect, test } from "vitest"
import { tableLinkClick } from "./command"

describe("services table link clicks", () => {
	test("a plain click on the service link navigates once, without the row", () => {
		expect(tableLinkClick({ href: "/services/checkout", button: 0, hasModifier: false })).toBe("Navigate")
	})

	test("a modified or middle click is left to the browser (new tab)", () => {
		expect(tableLinkClick({ href: "/services/checkout", button: 0, hasModifier: true })).toBe("Browser")
		expect(tableLinkClick({ href: "/services/checkout", button: 1, hasModifier: false })).toBe("Browser")
	})

	test("a click outside any link is the row's", () => {
		expect(tableLinkClick({ href: null, button: 0, hasModifier: false })).toBe("Row")
	})
})
