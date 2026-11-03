import { describe, expect, it } from "vitest"
import { PROBE_CATEGORIES, PROBE_SIGNATURES, SCANNER_AGENTS, probeCategoryOf } from "./security-telemetry"
import { Array as Arr, String as Str } from "effect"

describe("probe catalog", () => {
	it("never lists a token inside another", () => {
		// multiSearchFirstIndex picks the leftmost match, so an overlapping pair could file one
		// probe under the other's category.
		for (const list of [PROBE_SIGNATURES, SCANNER_AGENTS]) {
			const tokens = Arr.map(list, (entry) => Str.toLowerCase(entry.token))
			for (const token of tokens) {
				expect(Arr.filter(tokens, (other) => other !== token && Str.includes(token)(other))).toEqual(
					[],
				)
			}
		}
	})

	it("files every signature under a listed category", () => {
		const categories = new Set(Arr.map(PROBE_CATEGORIES, (category) => category.id))
		const filed = Arr.map(PROBE_SIGNATURES, (signature) => probeCategoryOf(signature.token))
		expect(Arr.filter(filed, (category) => category === undefined || !categories.has(category))).toEqual(
			[],
		)
		expect(probeCategoryOf("")).toBeUndefined()
	})
})
