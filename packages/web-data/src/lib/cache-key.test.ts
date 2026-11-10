import { describe, expect, it } from "vitest"

import { encodeKey } from "./cache-key"

describe("encodeKey", () => {
	it("is order-insensitive across object keys", () => {
		expect(encodeKey({ a: 1, b: 2 })).toBe(encodeKey({ b: 2, a: 1 }))
	})

	it("drops undefined values", () => {
		expect(encodeKey({ a: 1, b: undefined })).toBe(encodeKey({ a: 1 }))
	})

	it("snaps timestamps to the 15s grid", () => {
		expect(encodeKey({ startTime: "2026-03-08 14:30:07" })).toBe(
			encodeKey({ startTime: "2026-03-08 14:30:00" }),
		)
	})
})
