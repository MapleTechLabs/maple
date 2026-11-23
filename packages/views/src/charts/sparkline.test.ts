import { Option } from "effect"
import { describe, expect, test } from "vitest"
import { hoveredPointLabel } from "./sparkline"

const HOURLY = ["2026-10-01 00:00:00", "2026-10-01 01:00:00", "2026-10-01 02:00:00"]
const DAILY = ["2026-10-01 00:00:00", "2026-10-02 00:00:00", "2026-10-03 00:00:00"]

describe("hoveredPointLabel", () => {
	test("a same-day series names the hovered hour without a date", () => {
		const label = Option.getOrThrow(hoveredPointLabel(HOURLY, 2, "UTC"))
		expect(label).toMatch(/2/)
		expect(label).not.toMatch(/Oct/)
	})

	test("a daily series names the hovered day", () => {
		expect(Option.getOrThrow(hoveredPointLabel(DAILY, 1, "UTC"))).toMatch(/Oct 2/)
	})

	test("the label follows the viewer's time zone", () => {
		const utc = Option.getOrThrow(hoveredPointLabel(HOURLY, 0, "UTC"))
		const tokyo = Option.getOrThrow(hoveredPointLabel(HOURLY, 0, "Asia/Tokyo"))
		expect(tokyo).not.toBe(utc)
	})

	test("an index past the series has no label", () => {
		expect(Option.isNone(hoveredPointLabel(HOURLY, 3, "UTC"))).toBe(true)
	})
})
