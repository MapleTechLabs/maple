import { describe, expect, it } from "vitest"
import { Array as Arr, Schema, String as Str } from "effect"
import {
	AlertMaintenanceSchedule,
	maintenanceOccurrences,
	maintenanceSilenceReason,
	maintenanceWindowCoversSeries,
	type AlertMaintenanceScheduleWeekly,
	type MaintenanceWeekday,
} from "./alert-maintenance-windows"

const ms = (iso: string) => Date.parse(iso)
const isoRanges = (ranges: ReadonlyArray<{ startsAtMs: number; endsAtMs: number }>) =>
	Arr.map(ranges, (r) => [new Date(r.startsAtMs).toISOString(), new Date(r.endsAtMs).toISOString()])

const weekly = (
	timeZone: string,
	days: ReadonlyArray<MaintenanceWeekday>,
	startTime: string,
	durationMinutes: number,
): AlertMaintenanceScheduleWeekly => ({ _tag: "weekly", timeZone, days, startTime, durationMinutes })

describe("maintenanceOccurrences: once", () => {
	const once = {
		_tag: "once" as const,
		startsAt: ms("2026-11-07T10:00:00Z"),
		endsAt: ms("2026-11-07T12:00:00Z"),
	}

	it("returns the window when it overlaps the range, including one already running", () => {
		expect(
			isoRanges(maintenanceOccurrences(once, ms("2026-11-07T11:00:00Z"), ms("2026-11-08T00:00:00Z"))),
		).toEqual([["2026-11-07T10:00:00.000Z", "2026-11-07T12:00:00.000Z"]])
	})

	it("returns nothing for a range before or after it, or an empty range", () => {
		expect(maintenanceOccurrences(once, ms("2026-11-06T00:00:00Z"), ms("2026-11-07T10:00:00Z"))).toEqual(
			[],
		)
		expect(maintenanceOccurrences(once, ms("2026-11-07T12:00:00Z"), ms("2026-11-08T00:00:00Z"))).toEqual(
			[],
		)
		expect(maintenanceOccurrences(once, ms("2026-11-07T11:00:00Z"), ms("2026-11-07T11:00:00Z"))).toEqual(
			[],
		)
	})
})

describe("maintenanceOccurrences: weekly", () => {
	it("opens on every listed day across a week", () => {
		const schedule = weekly("UTC", ["mon", "wed", "fri"], "10:00", 60)
		expect(
			isoRanges(
				maintenanceOccurrences(schedule, ms("2026-11-02T00:00:00Z"), ms("2026-11-09T00:00:00Z")),
			),
		).toEqual([
			["2026-11-02T10:00:00.000Z", "2026-11-02T11:00:00.000Z"],
			["2026-11-04T10:00:00.000Z", "2026-11-04T11:00:00.000Z"],
			["2026-11-06T10:00:00.000Z", "2026-11-06T11:00:00.000Z"],
		])
	})

	it("includes an occurrence that started before the range and is still running across the week boundary", () => {
		const schedule = weekly("UTC", ["sun"], "23:00", 120)
		expect(
			isoRanges(
				maintenanceOccurrences(schedule, ms("2026-11-09T00:30:00Z"), ms("2026-11-09T12:00:00Z")),
			),
		).toEqual([["2026-11-08T23:00:00.000Z", "2026-11-09T01:00:00.000Z"]])
	})

	it("leaves out an occurrence that ended exactly at the range start", () => {
		const schedule = weekly("UTC", ["sun"], "23:00", 60)
		expect(
			maintenanceOccurrences(schedule, ms("2026-11-09T00:00:00Z"), ms("2026-11-09T12:00:00Z")),
		).toEqual([])
	})

	it("keeps a multi-day occurrence that began days before the range", () => {
		const schedule = weekly("UTC", ["mon"], "00:00", 6 * 24 * 60)
		expect(
			isoRanges(
				maintenanceOccurrences(schedule, ms("2026-11-07T00:00:00Z"), ms("2026-11-07T01:00:00Z")),
			),
		).toEqual([["2026-11-02T00:00:00.000Z", "2026-11-08T00:00:00.000Z"]])
	})

	it("reads the start time in the window's zone and follows its offset changes (Europe/Berlin)", () => {
		const schedule = weekly("Europe/Berlin", ["sun"], "04:00", 60)
		const starts = maintenanceOccurrences(
			schedule,
			ms("2026-03-21T00:00:00Z"),
			ms("2026-04-06T00:00:00Z"),
		)
		const startIsos = Arr.map(starts, (o) => new Date(o.startsAtMs).toISOString())
		// CET (+1) before the spring-forward, CEST (+2) from it on.
		expect(startIsos).toEqual([
			"2026-03-22T03:00:00.000Z",
			"2026-03-29T02:00:00.000Z",
			"2026-04-05T02:00:00.000Z",
		])
	})

	it("moves a start in the spring-forward gap to the next valid time (Europe/Berlin 02:00)", () => {
		const schedule = weekly("Europe/Berlin", ["sun"], "02:00", 60)
		expect(
			isoRanges(
				maintenanceOccurrences(schedule, ms("2026-03-29T00:00:00Z"), ms("2026-03-30T00:00:00Z")),
			),
		).toEqual([["2026-03-29T01:00:00.000Z", "2026-03-29T02:00:00.000Z"]])
	})

	it("moves a start in the spring-forward gap to the next valid time (America/New_York 02:30)", () => {
		const schedule = weekly("America/New_York", ["sun"], "02:30", 30)
		expect(
			isoRanges(
				maintenanceOccurrences(schedule, ms("2026-03-08T00:00:00Z"), ms("2026-03-09T00:00:00Z")),
			),
		).toEqual([["2026-03-08T07:30:00.000Z", "2026-03-08T08:00:00.000Z"]])
	})

	it("takes the first of a repeated fall-back time", () => {
		const newYork = weekly("America/New_York", ["sun"], "01:30", 30)
		expect(
			isoRanges(
				maintenanceOccurrences(newYork, ms("2026-11-01T00:00:00Z"), ms("2026-11-02T00:00:00Z")),
			),
		).toEqual([["2026-11-01T05:30:00.000Z", "2026-11-01T06:00:00.000Z"]])
		const berlin = weekly("Europe/Berlin", ["sun"], "02:30", 30)
		expect(
			isoRanges(maintenanceOccurrences(berlin, ms("2026-10-24T00:00:00Z"), ms("2026-10-26T00:00:00Z"))),
		).toEqual([["2026-10-25T00:30:00.000Z", "2026-10-25T01:00:00.000Z"]])
	})

	it("keeps a weekday start at the same local time across New York's spring-forward", () => {
		const schedule = weekly("America/New_York", ["mon"], "09:00", 60)
		const starts = maintenanceOccurrences(
			schedule,
			ms("2026-03-02T00:00:00Z"),
			ms("2026-03-10T00:00:00Z"),
		)
		const startIsos = Arr.map(starts, (o) => new Date(o.startsAtMs).toISOString())
		expect(startIsos).toEqual(["2026-03-02T14:00:00.000Z", "2026-03-09T13:00:00.000Z"])
	})

	it("picks the zone's local weekday, not the UTC one", () => {
		// Tuesday 01:00 in Tokyo is still Monday in UTC.
		const schedule = weekly("Asia/Tokyo", ["tue"], "01:00", 60)
		expect(
			isoRanges(
				maintenanceOccurrences(schedule, ms("2026-11-02T00:00:00Z"), ms("2026-11-03T00:00:00Z")),
			),
		).toEqual([["2026-11-02T16:00:00.000Z", "2026-11-02T17:00:00.000Z"]])
	})
})

describe("AlertMaintenanceSchedule", () => {
	const decode = Schema.decodeUnknownExit(AlertMaintenanceSchedule)
	const valid = {
		_tag: "weekly",
		timeZone: "Europe/Berlin",
		days: ["sat"],
		startTime: "02:00",
		durationMinutes: 60,
	}

	it("accepts a weekly schedule in an IANA zone and a one-off window", () => {
		expect(decode(valid)._tag).toBe("Success")
		expect(
			decode({ _tag: "once", startsAt: "2026-11-07T10:00:00.000Z", endsAt: "2026-11-07T11:00:00.000Z" })
				._tag,
		).toBe("Success")
	})

	it.each([
		["an unknown time zone", { ...valid, timeZone: "Mars/Olympus" }],
		["no days", { ...valid, days: [] }],
		["a repeated day", { ...valid, days: ["sat", "sat"] }],
		["a malformed start time", { ...valid, startTime: "24:00" }],
		["a duration under 5 minutes", { ...valid, durationMinutes: 4 }],
		["a duration over a week", { ...valid, durationMinutes: 7 * 24 * 60 + 1 }],
		[
			"a one-off window that ends before it starts",
			{ _tag: "once", startsAt: "2026-11-07T10:00:00Z", endsAt: "2026-11-07T09:00:00Z" },
		],
		[
			"a one-off window over 30 days",
			{ _tag: "once", startsAt: "2026-11-01T00:00:00Z", endsAt: "2026-12-02T00:00:00Z" },
		],
	])("rejects %s", (_label, input) => {
		expect(decode(input)._tag).toBe("Failure")
	})
})

describe("maintenanceWindowCoversSeries", () => {
	it("covers a series named by service and environment, empty lists meaning all", () => {
		expect(maintenanceWindowCoversSeries({ services: ["checkout"] }, "checkout", "prod")).toBe(true)
		expect(maintenanceWindowCoversSeries({ services: ["checkout"] }, "cart", "prod")).toBe(false)
		expect(maintenanceWindowCoversSeries({ environments: ["staging"] }, "cart", "staging")).toBe(true)
		expect(
			maintenanceWindowCoversSeries(
				{ services: ["checkout"], environments: ["prod"] },
				"checkout",
				"staging",
			),
		).toBe(false)
	})

	it("never covers a series for a window that names no service or environment", () => {
		expect(maintenanceWindowCoversSeries({ tags: ["db"] }, "checkout", "prod")).toBe(false)
	})
})

describe("maintenanceSilenceReason", () => {
	it("names the window and keeps within the silence reason limit", () => {
		expect(maintenanceSilenceReason("DB vacuum", null)).toBe("Maintenance: DB vacuum")
		expect(maintenanceSilenceReason("DB vacuum", "weekly")).toBe("Maintenance: DB vacuum (weekly)")
		expect(maintenanceSilenceReason(Str.repeat(120)("x"), Str.repeat(400)("y")).length).toBe(500)
	})
})
