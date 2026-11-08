import { describe, expect, test } from "vitest"
import { groupByChoicesOf } from "./metrics-body"

const OFFERED = ["service.name", "attr.a", "attr.b", "attr.c", "resource.d", "resource.e", "resource.f"]

describe("group-by picker choices", () => {
	test("five attribute keys picked: no more keys offered, service.name still is", () => {
		const choices = groupByChoicesOf(OFFERED, ["attr.a", "attr.b", "attr.c", "resource.d", "resource.e"])
		expect(choices.items).toEqual(["service.name"])
	})

	test("the empty list names the cap only when the cap is why it is empty", () => {
		const full = ["attr.a", "attr.b", "attr.c", "resource.d", "resource.e"]
		expect(groupByChoicesOf(OFFERED, full).emptyText).toBe("At most 5 attribute fields")
		expect(groupByChoicesOf(OFFERED, ["attr.a"]).emptyText).toBe("No fields found")
		expect(groupByChoicesOf(["service.name", "attr.a"], ["service.name", "attr.a"]).emptyText).toBe(
			"All fields selected",
		)
	})
})
