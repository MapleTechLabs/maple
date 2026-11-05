import { describe, expect, it } from "vitest"
import { hourAlignedWindow, usersSearch } from "./window"

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

describe("usersSearch", () => {
	it("reads a bookmarked sub-hour preset as the last hour and keeps the rest of the search", () => {
		expect(usersSearch({ timePreset: "5m", q: "ada" })).toEqual({ timePreset: "1h", q: "ada" })
		expect(usersSearch({ timePreset: "24h" })).toEqual({ timePreset: "24h" })
	})
})
