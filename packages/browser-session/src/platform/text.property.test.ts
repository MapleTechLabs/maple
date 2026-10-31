import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { stringifyWellFormed } from "./json"
import { truncateText } from "./text"
import { randomUuid } from "./uuid"

/** What a strict parser such as serde_json accepts: no lone surrogate anywhere. */
const isWellFormed = (text: string) =>
	!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)
const hasLoneSurrogateEscape = (json: string) => /(?<!\\)(?:\\\\)*\\u[dD][89a-fA-F][0-9a-fA-F]{2}/.test(json)

describe("truncateText", () => {
	it("never cuts a well-formed string into an ill-formed one, and keeps a prefix within max", () => {
		fc.assert(
			fc.property(fc.string({ unit: "grapheme" }), fc.nat(64), (text, max) => {
				const out = truncateText(text, max)
				expect(out.length).toBeLessThanOrEqual(max)
				expect(text.startsWith(out)).toBe(true)
				expect(isWellFormed(out)).toBe(true)
				// At most the one unit of a pair it could not keep whole is lost.
				expect(out.length).toBeGreaterThanOrEqual(Math.min(text.length, max) - 1)
			}),
		)
	})

	it("leaves a string that fits untouched, suffix and all", () => {
		fc.assert(
			fc.property(fc.string(), fc.string({ maxLength: 3 }), (text, suffix) => {
				expect(truncateText(text, text.length, suffix)).toBe(text)
			}),
		)
	})
})

describe("stringifyWellFormed", () => {
	it("writes JSON with no lone surrogate that parses back to the value, each lone half as U+FFFD", () => {
		fc.assert(
			fc.property(fc.jsonValue(), fc.string({ unit: "binary" }), (value, text) => {
				const row = { value, text }
				const json = stringifyWellFormed(row)
				expect(hasLoneSurrogateEscape(json)).toBe(false)
				const parsed = JSON.parse(json)
				expect(isWellFormed(parsed.text)).toBe(true)
				expect(parsed.text.length).toBe(text.length)
				if (isWellFormed(text)) expect(json).toBe(JSON.stringify(row))
			}),
		)
	})

	it("keeps backslashes that only look like a surrogate escape", () => {
		expect(JSON.parse(stringifyWellFormed({ path: "C:\\ud83d" })).path).toBe("C:\\ud83d")
	})
})

describe("randomUuid", () => {
	it("is a v4 UUID without crypto.randomUUID", () => {
		const randomUUID = crypto.randomUUID
		Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true })
		try {
			const ids = Array.from({ length: 200 }, randomUuid)
			for (const id of ids)
				expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
			expect(new Set(ids).size).toBe(ids.length)
		} finally {
			Object.defineProperty(crypto, "randomUUID", { value: randomUUID, configurable: true })
		}
	})
})
