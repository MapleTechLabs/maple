import { describe, expect, it } from "vitest"
import { dateHourToUtcMs, utcMsToZonedDate } from "./timezone"

const iso = (ms: number) => new Date(ms).toISOString()

describe("dateHourToUtcMs", () => {
	it("is the identity for a UTC property", () => {
		expect(iso(dateHourToUtcMs("2026090914", "UTC")!)).toBe("2026-09-09T14:00:00.000Z")
	})

	it("shifts a fixed-offset zone by its offset", () => {
		// Asia/Tokyo is UTC+9 year-round: 14:00 local is 05:00 UTC.
		expect(iso(dateHourToUtcMs("2026090914", "Asia/Tokyo")!)).toBe("2026-09-09T05:00:00.000Z")
	})

	it("applies the summer offset for a DST zone in summer", () => {
		// America/Los_Angeles is UTC-7 in September (PDT): 14:00 local is 21:00 UTC.
		expect(iso(dateHourToUtcMs("2026090914", "America/Los_Angeles")!)).toBe("2026-09-09T21:00:00.000Z")
	})

	it("applies the winter offset for the same zone in winter", () => {
		// ...and UTC-8 in January (PST): the same wall-clock hour is 22:00 UTC. A naive fixed
		// offset would put this bucket an hour out for half the year.
		expect(iso(dateHourToUtcMs("2026011514", "America/Los_Angeles")!)).toBe("2026-01-15T22:00:00.000Z")
	})

	it("resolves the hour either side of a fall-back transition", () => {
		// 2026-11-01, US DST ends at 02:00 local. 01:00 local occurs twice; the hour before and
		// the hour after must still land on distinct, correctly-ordered instants.
		const before = dateHourToUtcMs("2026110100", "America/Los_Angeles")!
		const after = dateHourToUtcMs("2026110103", "America/Los_Angeles")!
		expect(iso(before)).toBe("2026-11-01T07:00:00.000Z")
		expect(iso(after)).toBe("2026-11-01T11:00:00.000Z")
		expect(after).toBeGreaterThan(before)
	})

	it("handles a half-hour offset zone", () => {
		// Asia/Kolkata is UTC+5:30 — the case that catches an implementation assuming whole hours.
		expect(iso(dateHourToUtcMs("2026090914", "Asia/Kolkata")!)).toBe("2026-09-09T08:30:00.000Z")
	})

	it("handles midnight without rolling the day", () => {
		expect(iso(dateHourToUtcMs("2026090900", "UTC")!)).toBe("2026-09-09T00:00:00.000Z")
		expect(iso(dateHourToUtcMs("2026090900", "Asia/Tokyo")!)).toBe("2026-09-08T15:00:00.000Z")
	})

	it("returns null rather than guessing at malformed input", () => {
		expect(dateHourToUtcMs("", "UTC")).toBeNull()
		expect(dateHourToUtcMs("20260909", "UTC")).toBeNull()
		expect(dateHourToUtcMs("2026090924", "UTC")).toBeNull()
		expect(dateHourToUtcMs("2026139914", "UTC")).toBeNull()
		expect(dateHourToUtcMs("(other)", "UTC")).toBeNull()
	})

	it("returns null for a timezone the runtime does not know", () => {
		expect(dateHourToUtcMs("2026090914", "Mars/Olympus_Mons")).toBeNull()
	})
})

describe("utcMsToZonedDate", () => {
	it("renders the property-local date, not the UTC one", () => {
		const instant = Date.parse("2026-09-09T02:00:00.000Z")
		expect(utcMsToZonedDate(instant, "UTC")).toBe("2026-09-09")
		// 02:00 UTC is still the previous evening in Los Angeles — asking GA4 for the UTC date
		// would miss a whole local day at the window edge.
		expect(utcMsToZonedDate(instant, "America/Los_Angeles")).toBe("2026-09-08")
		expect(utcMsToZonedDate(instant, "Asia/Tokyo")).toBe("2026-09-09")
	})

	it("returns null for an unknown timezone", () => {
		expect(utcMsToZonedDate(Date.now(), "Mars/Olympus_Mons")).toBeNull()
	})
})
