import { Array as Arr } from "effect"
import { describe, expect, test } from "vitest"
import { gradientId } from "./gradient-id"

// Real chart ids from callers: raw routes, spaces, parens, braces, unicode.
const NASTY = [
	"endpoint-GET (unmatched)",
	"GET /users/{id}",
	"spark caf\u00e9 \u2713",
	"a b",
	"a_b",
	"a\u00a0b",
]

describe("gradient ids", () => {
	test("ids built from caller text only use characters both renderers keep", () => {
		for (const raw of NASTY) expect(gradientId("spark", raw)).toMatch(/^[A-Za-z0-9_-]+$/)
	})

	test("distinct caller ids never collapse onto the same gradient", () => {
		const ids = Arr.map(NASTY, (raw) => gradientId("spark", raw))
		expect(new Set(ids).size).toBe(NASTY.length)
	})

	test("an id that is already safe is kept as is", () => {
		expect(gradientId("qbArea", "chart-1", "partial")).toBe("qbArea-chart-1-partial")
	})
})
