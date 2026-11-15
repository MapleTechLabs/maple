import { describe, expect, it } from "vitest"
import { Schema, String as Str } from "effect"
import { SavedViewState } from "./saved-views"

const accepts = Schema.is(SavedViewState)

describe("SavedViewState", () => {
	it("measures a state in bytes, so wide characters count for what they store as", () => {
		const where = (character: string) => ({ search: { where: Str.repeat(6000)(character) } })
		// 6,000 ASCII characters are about 6 kB; the same count of CJK characters is about 18 kB.
		expect(accepts(where("a"))).toBe(true)
		expect(accepts(where("\u6f22"))).toBe(false)
	})
})
