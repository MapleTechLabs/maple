import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { SearchConsoleDay, SearchConsoleTimeseriesRequest } from "./query-engine"

const isDay = Schema.is(SearchConsoleDay)

describe("SearchConsoleDay", () => {
	it("rejects days the calendar does not have", () => {
		expect(isDay("2026-02-31")).toBe(false)
		expect(isDay("2026-13-01")).toBe(false)
		expect(isDay("2026-00-10")).toBe(false)
		expect(isDay("2025-02-29")).toBe(false)
	})

	it("accepts real days, leap days included", () => {
		expect(isDay("2026-02-28")).toBe(true)
		expect(isDay("2024-02-29")).toBe(true)
		expect(isDay("2026-12-31")).toBe(true)
	})

	it("fails a request carrying an impossible completeThrough at decode", () => {
		const decode = Schema.decodeUnknownOption(SearchConsoleTimeseriesRequest)
		const request = {
			siteUrl: "sc-domain:acme.dev",
			startTime: "2026-02-01 00:00:00",
			endTime: "2026-02-28 00:00:00",
		}
		expect(decode({ ...request, completeThrough: "2026-02-31" })._tag).toBe("None")
		expect(decode({ ...request, completeThrough: "2026-02-27" })._tag).toBe("Some")
	})
})
