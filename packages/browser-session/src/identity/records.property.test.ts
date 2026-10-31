import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { parseVisitMarker } from "./visit"
import { parseVisitorRecord } from "./visitor"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Stored values a cookie jar or another script on the origin can hand back. */
const stored = fc.oneof(
	fc.string({ unit: "binary" }),
	fc.json(),
	fc
		.record({
			id: fc.oneof(fc.uuid(), fc.string(), fc.integer()),
			mintedAt: fc.oneof(fc.double(), fc.string()),
		})
		.map((value) => JSON.stringify(value)),
	fc.constantFrom('{"id":"<script>","mintedAt":1}', '{"__proto__":{"id":"x"}}', "null", "[]", "1e999"),
)

describe("parseVisitorRecord", () => {
	it("accepts only a UUID with a finite mint time, and never throws", () => {
		fc.assert(
			fc.property(stored, (raw) => {
				const record = parseVisitorRecord(raw)
				if (record === undefined) return
				expect(record.id).toMatch(UUID)
				expect(Number.isFinite(record.mintedAt)).toBe(true)
			}),
		)
	})

	it("reads back every record it could have written within the 400-day life", () => {
		fc.assert(
			fc.property(fc.uuid(), fc.integer({ min: 0, max: 399 * 24 * 60 * 60_000 }), (id, age) => {
				const mintedAt = Date.now() - age
				expect(parseVisitorRecord(JSON.stringify({ id, mintedAt }))).toEqual({ id, mintedAt })
			}),
		)
	})
})

describe("parseVisitMarker", () => {
	it("never throws and yields a non-negative integer time", () => {
		fc.assert(
			fc.property(stored, (raw) => {
				const marker = parseVisitMarker(raw)
				if (marker === undefined) return
				expect(Number.isSafeInteger(marker.at)).toBe(true)
				expect(marker.at).toBeGreaterThanOrEqual(0)
			}),
		)
	})

	it("round-trips the markers this build and older builds write", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 2 ** 50 }),
				fc.stringMatching(/^[0-9a-z]{0,10}$/),
				(at, token) => {
					expect(parseVisitMarker(token ? `${at}.${token}` : String(at))).toEqual({ at, token })
				},
			),
		)
	})
})
