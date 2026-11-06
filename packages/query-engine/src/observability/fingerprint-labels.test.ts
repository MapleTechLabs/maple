import { describe, expect, it } from "vitest"
import { isUnlabelledError, spanErrorLabel } from "./fingerprint-labels"

const span = (overrides: Partial<Parameters<typeof spanErrorLabel>[0]>) => ({
	spanName: "",
	httpMethod: "",
	httpRoute: "",
	httpStatus: "",
	...overrides,
})

describe("spanErrorLabel", () => {
	it("prefers method, status and route", () => {
		expect(
			spanErrorLabel(
				span({ spanName: "fetch", httpMethod: "GET", httpRoute: "/api/org", httpStatus: "404" }),
			),
		).toBe("GET 404 /api/org")
	})

	it("does not repeat a method the span name already leads with", () => {
		expect(
			spanErrorLabel(span({ spanName: "GET /wp-login.php", httpMethod: "GET", httpStatus: "404" })),
		).toBe("GET 404 /wp-login.php")
	})

	it("falls back to the span name, saying there was no exception", () => {
		expect(spanErrorLabel(span({ spanName: "scrape.attempt" }))).toBe("scrape.attempt (no exception)")
		expect(spanErrorLabel(span({}))).toBe("")
	})
})

describe("isUnlabelledError", () => {
	it("matches only the placeholder label", () => {
		expect(isUnlabelledError("Unknown Error")).toBe(true)
		expect(isUnlabelledError("")).toBe(true)
		expect(isUnlabelledError("TypeError")).toBe(false)
	})
})
