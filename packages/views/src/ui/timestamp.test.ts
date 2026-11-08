import { Array as Arr } from "effect"
import { describe, expect, test } from "vitest"
import { timestampDistance, timestampZoneRows } from "./timestamp"

const NOON_UTC = Date.UTC(2026, 10, 4, 12, 26, 0)

describe("timestampZoneRows", () => {
	test("reads the instant in the page zone, the local zone and UTC, page zone first", () => {
		const rows = timestampZoneRows(NOON_UTC, "America/New_York", "Europe/Berlin")
		expect(Arr.map(rows, (row) => row.label)).toEqual(["New York", "Local", "UTC"])
		expect(Arr.map(rows, (row) => row.offset)).toEqual(["UTC-5", "UTC+1", ""])
		expect(rows[0]?.time).toContain("07:26:00 AM")
		expect(rows[2]?.time).toContain("12:26:00 PM")
	})

	test("lists a zone once when the page zone is the viewer's own or UTC", () => {
		expect(
			Arr.map(timestampZoneRows(NOON_UTC, "Europe/Berlin", "Europe/Berlin"), (row) => row.label),
		).toEqual(["Local", "UTC"])
		expect(Arr.map(timestampZoneRows(NOON_UTC, "UTC", "UTC"), (row) => row.label)).toEqual(["UTC"])
	})

	test("shows milliseconds only when the instant has them", () => {
		expect(timestampZoneRows(NOON_UTC + 512, "UTC", "UTC")[0]?.time).toContain("12:26:00.512")
		expect(timestampZoneRows(NOON_UTC, "UTC", "UTC")[0]?.time).not.toContain(".")
	})
})

describe("timestampDistance", () => {
	test("spells the distance out in both directions", () => {
		expect(timestampDistance(NOON_UTC, NOON_UTC + 38 * 60_000)).toBe("38 minutes ago")
		expect(timestampDistance(NOON_UTC, NOON_UTC - 2 * 3_600_000)).toBe("in 2 hours")
		expect(timestampDistance(NOON_UTC, NOON_UTC + 1_000)).toBe("now")
	})
})
