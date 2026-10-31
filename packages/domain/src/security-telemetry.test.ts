import { describe, expect, it } from "vitest"
import { PROBE_CATEGORIES, PROBE_SIGNATURES, SCANNER_AGENTS, probeCategoryOf } from "./security-telemetry"

describe("probe catalog", () => {
	it("never lists a token inside another", () => {
		// multiSearchFirstIndex picks the leftmost match, so an overlapping pair could file one
		// probe under the other's category.
		for (const list of [PROBE_SIGNATURES, SCANNER_AGENTS]) {
			const tokens = list.map((entry) => entry.token.toLowerCase())
			for (const token of tokens) {
				expect(tokens.filter((other) => other !== token && other.includes(token))).toEqual([])
			}
		}
	})

	it("files every signature under a listed category", () => {
		const categories = new Set(PROBE_CATEGORIES.map((category) => category.id))
		const filed = PROBE_SIGNATURES.map((signature) => probeCategoryOf(signature.token))
		expect(filed.filter((category) => category === undefined || !categories.has(category))).toEqual([])
		expect(probeCategoryOf("")).toBeUndefined()
	})
})
