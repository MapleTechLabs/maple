import { describe, expect, it } from "vitest"

import { initialsFrom } from "./initials"

describe("initialsFrom", () => {
	it("takes the first and last word", () => {
		expect(initialsFrom("Ada Lovelace")).toBe("AL")
		expect(initialsFrom("Christopher Alexander Montgomery III")).toBe("CI")
		expect(initialsFrom("Aleksandra Wiśniewska-Kowalczyk")).toBe("AK")
	})

	it("keeps emoji and combining marks whole", () => {
		expect(initialsFrom("🦊 Fox")).toBe("🦊F")
		expect(initialsFrom("👩🏽‍💻 Priya")).toBe("👩🏽‍💻P")
		expect(initialsFrom("Émile")).toBe("É")
	})

	it("handles short, spaced, lowercase and email-only names", () => {
		expect(initialsFrom("Jo")).toBe("J")
		expect(initialsFrom("  Sam   Lee ")).toBe("SL")
		expect(initialsFrom("dana")).toBe("D")
		expect(initialsFrom("bartholomew.fitzgerald@northwind.example.com")).toBe("BF")
	})

	it("falls back on empty input", () => {
		expect(initialsFrom("")).toBe("?")
		expect(initialsFrom(null, "U")).toBe("U")
		expect(initialsFrom("   ")).toBe("?")
	})
})
