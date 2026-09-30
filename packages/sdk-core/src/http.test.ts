import { describe, expect, it } from "vitest"
import { filterHeaderAttribute, resolveHeaderCapture } from "./http-headers"
import {
	type AttributeValue,
	DEFAULT_ERROR_STATUS,
	httpErrorType,
	inStatusRanges,
	type ReadAttribute,
	responseStatus,
} from "./http-status"

const attributes =
	(values: Record<string, AttributeValue>): ReadAttribute =>
	(key) =>
		values[key]

describe("http status policy", () => {
	it("matches codes and inclusive ranges", () => {
		expect(inStatusRanges(503, [[500, 599]])).toBe(true)
		expect(inStatusRanges(429, [429])).toBe(true)
		expect(inStatusRanges(404, [[500, 599], 429])).toBe(false)
	})

	it("reads the current and the legacy status key", () => {
		expect(responseStatus(attributes({ "http.response.status_code": 502 }))).toBe(502)
		expect(responseStatus(attributes({ "http.status_code": "404" }))).toBe(404)
		expect(responseStatus(attributes({}))).toBeUndefined()
	})

	it("counts every 4xx and 5xx by default, as the HTTP conventions say for client spans", () => {
		expect(inStatusRanges(400, DEFAULT_ERROR_STATUS)).toBe(true)
		expect(inStatusRanges(599, DEFAULT_ERROR_STATUS)).toBe(true)
		expect(inStatusRanges(399, DEFAULT_ERROR_STATUS)).toBe(false)
	})

	it("types the error by the status code alone", () => {
		expect(httpErrorType(503)).toEqual({ "error.type": "503" })
		expect(httpErrorType("TypeError")).toEqual({ "error.type": "TypeError" })
	})
})

describe("header capture", () => {
	it("never keeps credential headers, even when listed", () => {
		expect(
			resolveHeaderCapture({ request: ["Authorization", "X-Request-Id"], response: ["set-cookie"] }),
		).toEqual({
			request: ["x-request-id"],
			response: [],
		})
	})

	it("keeps only allowlisted header attributes, as string arrays", () => {
		const capture = resolveHeaderCapture({ response: ["x-cache"] })
		expect(filterHeaderAttribute(capture, "http.response.header.x-cache", "HIT")).toEqual(["HIT"])
		expect(filterHeaderAttribute(capture, "http.response.header.server", "nginx")).toBeUndefined()
		expect(filterHeaderAttribute(capture, "http.request.header.x-cache", "HIT")).toBeUndefined()
		expect(filterHeaderAttribute(capture, "url.full", "https://a.test")).toBe("https://a.test")
	})
})
