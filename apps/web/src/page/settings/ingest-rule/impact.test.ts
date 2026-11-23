import { describe, expect, test } from "vitest"
import { hourWindow } from "./impact"

describe("impact windows", () => {
	test("end on the next hour, so every bucket in the window is whole", () => {
		expect(hourWindow(Date.UTC(2026, 10, 23, 12, 45), 24)).toEqual({
			start_time: "2026-11-22T13:00:00.000Z",
			end_time: "2026-11-23T13:00:00.000Z",
		})
		expect(hourWindow(Date.UTC(2026, 10, 23, 13), 1)).toEqual({
			start_time: "2026-11-23T13:00:00.000Z",
			end_time: "2026-11-23T14:00:00.000Z",
		})
	})
})
