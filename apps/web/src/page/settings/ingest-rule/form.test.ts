import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { joinList, splitLines, splitList } from "./form"

// Values a rule stores without surrounding whitespace; the editor trims list entries.
const ListValue = Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed())

describe("editor lists", () => {
	it.prop("a saved list survives being edited and saved again", [Schema.Array(ListValue)], ([values]) => {
		expect(splitList(joinList(values))).toEqual(values)
	})

	it("keeps a comma inside a value and a pattern's leading space", () => {
		expect(splitList("GET /a\\,b, x")).toEqual(["GET /a,b", "x"])
		expect(splitLines(" token\n\nORD-[0-9]+")).toEqual([" token", "ORD-[0-9]+"])
	})
})
