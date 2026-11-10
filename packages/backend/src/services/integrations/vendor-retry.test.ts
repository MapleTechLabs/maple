import { Option } from "effect"
import { describe, expect, it } from "vitest"
import { parseDeltaSeconds, parseRetryAfterSeconds } from "./vendor-retry"

const NOW = Date.parse("2026-11-10T12:00:00.000Z")

describe("parseRetryAfterSeconds", () => {
	it("reads delta-seconds and an HTTP-date counted from now", () => {
		expect(parseRetryAfterSeconds("30", NOW)).toEqual(Option.some(30))
		expect(parseRetryAfterSeconds("Tue, 10 Nov 2026 12:01:30 GMT", NOW)).toEqual(Option.some(90))
	})

	it("clamps a date in the past to zero and rejects garbage", () => {
		expect(parseRetryAfterSeconds("Tue, 10 Nov 2026 11:00:00 GMT", NOW)).toEqual(Option.some(0))
		expect(parseRetryAfterSeconds("soon", NOW)).toEqual(Option.none())
		expect(parseRetryAfterSeconds(undefined, NOW)).toEqual(Option.none())
	})
})

describe("parseDeltaSeconds", () => {
	it("rejects negative values", () => {
		expect(parseDeltaSeconds("-1")).toEqual(Option.none())
		expect(parseDeltaSeconds("42")).toEqual(Option.some(42))
	})
})
