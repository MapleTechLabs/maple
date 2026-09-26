import { describe, expect, it } from "vitest"
import { decodeSegment, hrefFor, parseLocation } from "./router"

describe("router helpers", () => {
	it("keeps a malformed escape instead of throwing", () => {
		expect(decodeSegment("%E0%A4%A")).toBe("%E0%A4%A")
		expect(decodeSegment("GET%20%2Fusers")).toBe("GET /users")
	})

	it("round-trips a path and its query", () => {
		const href = hrefFor("/traces", new URLSearchParams({ service: "api", range: "6h" }))
		expect(href).toBe("#/traces?service=api&range=6h")
		const location = parseLocation(href.slice(1))
		expect(location.path).toBe("/traces")
		expect(location.query.get("range")).toBe("6h")
	})

	it("falls back to the traces list for an empty hash", () => {
		expect(parseLocation("").path).toBe("/traces")
	})
})
