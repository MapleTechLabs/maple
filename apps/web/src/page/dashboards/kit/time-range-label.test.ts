import { describe, expect, test } from "vitest"
import { TimeRangeSchema } from "@maple/widgets/dashboard"
import { Schema } from "effect"
import { widgetTimeRangeLabel } from "./time-range-label"

const NOW = Date.parse("2026-10-01T12:00:00Z")
const absolute = (startTime: string, endTime: string) =>
	Schema.decodeUnknownSync(TimeRangeSchema)({ type: "absolute", startTime, endTime })

describe("widgetTimeRangeLabel", () => {
	test("a relative window reads as its preset", () => {
		expect(widgetTimeRangeLabel({ type: "relative", value: "7d" }, "UTC", NOW)).toBe("Last 7 days")
	})

	test("an absolute window ending now reads as its length", () => {
		const range = absolute("2026-10-01T10:00:00.000Z", "2026-10-01T12:00:00.000Z")
		expect(widgetTimeRangeLabel(range, "UTC", NOW)).toBe("Last 2 hours")
	})

	test("an absolute window in the past reads as both ends in the zone", () => {
		const range = absolute("2026-09-01T10:00:00.000Z", "2026-09-02T10:00:00.000Z")
		expect(widgetTimeRangeLabel(range, "UTC", NOW)).toBe("Sep 1, 10:00 - Sep 2, 10:00")
	})
})
