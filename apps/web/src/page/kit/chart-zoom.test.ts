import { describe, expect, test } from "vitest"
import { zoomSearchPatch } from "./chart-zoom"

describe("zoomSearchPatch", () => {
	test("a dragged span becomes whole-second bounds that contain it, and drops the preset", () => {
		expect(
			zoomSearchPatch({
				startMs: Date.parse("2026-10-01T11:00:00.400Z"),
				endMs: Date.parse("2026-10-01T11:30:00.200Z"),
			}),
		).toEqual({
			startTime: "2026-10-01 11:00:00",
			endTime: "2026-10-01 11:30:01",
			timePreset: undefined,
		})
	})

	test("a sliver of a drag still opens a minute", () => {
		const at = Date.parse("2026-10-01T11:00:00Z")
		expect(zoomSearchPatch({ startMs: at, endMs: at + 4_000 })).toEqual({
			startTime: "2026-10-01 11:00:00",
			endTime: "2026-10-01 11:01:00",
			timePreset: undefined,
		})
	})
})
