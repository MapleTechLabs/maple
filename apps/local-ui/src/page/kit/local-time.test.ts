import { describe, expect, it } from "vitest"
import { formatDateTime, formatTimestamp } from "./local-time"

const utc = { locale: "en-US", timeZone: "UTC" }
const tokyo = { locale: "en-US", timeZone: "Asia/Tokyo" }
const at = "2026-10-01 23:30:05.042"
const atMs = Date.UTC(2026, 9, 1, 23, 30, 5, 42)

describe("formatDateTime", () => {
	it("renders the wall clock of the given zone with millis", () => {
		expect(formatDateTime(utc, at)).toBe("Oct 1, 2026 23:30:05.042")
		expect(formatDateTime(tokyo, at)).toBe("Oct 2, 2026 08:30:05.042")
	})

	it("renders a dash for an unparseable time", () => {
		expect(formatDateTime(utc, "not a time")).toBe("-")
	})
})

describe("formatTimestamp", () => {
	it("drops the day when it is the same local day as now", () => {
		expect(formatTimestamp(utc, at, { nowMs: atMs + 60_000 })).toBe("23:30:05.042")
		expect(formatTimestamp(utc, at, { nowMs: atMs + 60_000, precision: "s" })).toBe("23:30:05")
	})

	it("adds the day once the zone has crossed midnight", () => {
		expect(formatTimestamp(tokyo, at, { nowMs: atMs - 9 * 60 * 60 * 1000 })).toBe("Oct 2 08:30:05.042")
	})
})
