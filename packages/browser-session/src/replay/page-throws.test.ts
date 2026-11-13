import { afterEach, describe, expect, it, vi } from "vitest"
import { isPageThrow, watchPageThrows } from "./page-throws"

const rejected = new SyntaxError("Failed to parse the rule")

/** A stylesheet whose `insertRule` rejects one rule, as a browser does for a selector it does not know. */
const stubSheet = () => {
	class FakeSheet {
		readonly rules: string[] = []
		insertRule(rule: string, index = 0): number {
			if (rule.includes("-moz-")) throw rejected
			this.rules.splice(index, 0, rule)
			return index
		}
	}
	vi.stubGlobal("CSSStyleSheet", FakeSheet)
	return FakeSheet
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("watchPageThrows", () => {
	it("gives the page the method's own error and knows it was not the recorder's", () => {
		const Sheet = stubSheet()
		const release = watchPageThrows()
		const sheet = new Sheet()

		expect(() => sheet.insertRule(".a::-moz-focus-inner{border:0}")).toThrow(rejected)
		expect(isPageThrow(rejected)).toBe(true)
		expect(isPageThrow(new TypeError("observer failed"))).toBe(false)
		// A call that succeeds is untouched.
		expect(sheet.insertRule(".a{color:red}", 0)).toBe(0)
		expect(sheet.rules).toEqual([".a{color:red}"])
		release()
	})

	it("hands the method back once the last recorder released", () => {
		const Sheet = stubSheet()
		const original = Sheet.prototype.insertRule
		const first = watchPageThrows()
		const second = watchPageThrows()
		const watched = Sheet.prototype.insertRule

		first()
		first()
		expect(Sheet.prototype.insertRule).toBe(watched)
		second()

		expect(watched).not.toBe(original)
		expect(Sheet.prototype.insertRule).toBe(original)
	})

	it("leaves a patch another library put on top in place", () => {
		const Sheet = stubSheet()
		const release = watchPageThrows()
		const patched = vi.fn(() => 7)
		Sheet.prototype.insertRule = patched

		release()

		expect(Sheet.prototype.insertRule).toBe(patched)
	})
})
