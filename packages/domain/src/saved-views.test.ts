import { describe, expect, it } from "vitest"
import { Schema, String as Str } from "effect"
import { SavedViewName, SavedViewState } from "./saved-views"

const accepts = Schema.is(SavedViewState)
const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))

describe("SavedViewState", () => {
	it("measures a state in bytes, so wide characters count for what they store as", () => {
		const where = (character: string) => ({ search: { where: Str.repeat(6000)(character) } })
		// 6,000 ASCII characters are about 6 kB; the same count of CJK characters is about 18 kB.
		expect(accepts(where("a"))).toBe(true)
		expect(accepts(where("\u6f22"))).toBe(false)
	})

	it("refuses a state nested deeper than a search param ever is, whatever the stack allows", () => {
		const nested = (depth: number) =>
			parseJson(`${Str.repeat(depth)("[")}"leaf"${Str.repeat(depth)("]")}`)
		expect(accepts({ search: { filter: nested(7) } })).toBe(true)
		expect(accepts({ search: { filter: nested(9) } })).toBe(false)
		expect(accepts({ search: { filter: nested(20_000) } })).toBe(false)
	})

	it("refuses text Postgres cannot store or a URL cannot carry", () => {
		const acceptsName = Schema.is(SavedViewName)
		expect(acceptsName("Checkout errors")).toBe(true)
		expect(acceptsName("nul\u0000inside")).toBe(false)
		expect(accepts({ search: { where: "lone \ud800 surrogate" } })).toBe(false)
		expect(accepts({ search: { "key\u0000": "value" } })).toBe(false)
		expect(accepts({ search: {}, metricName: "bad\ud800name" })).toBe(false)
		expect(accepts({ search: { where: "plain \u{1f600} text" } })).toBe(true)
	})
})
