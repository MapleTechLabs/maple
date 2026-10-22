import { Option, Schema } from "effect"
import { describe, expect, test } from "vitest"
import { cachedAs } from "./cached"

describe("cachedAs", () => {
	const Row = Schema.Struct({ name: Schema.String, count: Schema.Number })

	test("accepts a legacy result that carries more fields than the slot reads", () => {
		expect(cachedAs(Row)({ name: "a", count: 1, extra: true })).toEqual(
			Option.some({ name: "a", count: 1, extra: true }),
		)
	})

	test("rejects a result of another shape, so the page fetches instead", () => {
		expect(cachedAs(Row)({ name: "a", count: "1" })).toEqual(Option.none())
	})
})
