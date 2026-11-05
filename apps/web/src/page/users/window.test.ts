import { describe, expect, it } from "vitest"
import { hourAlignedWindow } from "./window"

describe("hourAlignedWindow", () => {
	it("starts the window on its UTC hour and leaves the end alone", () => {
		expect(
			hourAlignedWindow({ startTime: "2026-11-04 11:54:15", endTime: "2026-11-05 11:54:15" }),
		).toEqual({
			startTime: "2026-11-04 11:00:00",
			endTime: "2026-11-05 11:54:15",
		})
	})
})
