import { Array as Arr, String as Str } from "effect"
import { describe, expect, it } from "vitest"
import { foldIcsLine, icsDateTime, icsText, renderOnCallCalendar } from "./oncall-ics"

const at = (iso: string) => Date.parse(iso)
const names = new Map([
	["user_ana", "Ana Alves"],
	["user_ben", "Ben Brook"],
])

const feed = (scheduleName = "API primary") =>
	renderOnCallCalendar({
		scheduleId: "sched-1",
		scheduleName,
		shifts: [
			{ userId: "user_ana", startMs: at("2026-11-09T08:00:00Z"), endMs: at("2026-11-16T08:00:00Z") },
			{ userId: "user_ben", startMs: at("2026-11-16T08:00:00Z"), endMs: at("2026-11-23T08:00:00Z") },
			{ userId: "user_gone", startMs: at("2026-11-23T08:00:00Z"), endMs: at("2026-11-30T08:00:00Z") },
		],
		nameOf: (userId) => names.get(userId) ?? null,
		nowMs: at("2026-11-10T12:00:00Z"),
	})

const lines = (body: string) => Str.split("\r\n")(body)
const valuesOf = (body: string, property: string) =>
	Arr.map(
		Arr.filter(lines(body), (line) => Str.startsWith(`${property}:`)(line)),
		(line) => Str.slice(property.length + 1)(line),
	)

describe("renderOnCallCalendar", () => {
	it("writes one event per shift, in UTC, naming who is on call", () => {
		const body = feed()
		expect(valuesOf(body, "DTSTART")).toEqual([
			"20261109T080000Z",
			"20261116T080000Z",
			"20261123T080000Z",
		])
		expect(valuesOf(body, "DTEND")).toEqual(["20261116T080000Z", "20261123T080000Z", "20261130T080000Z"])
		expect(valuesOf(body, "SUMMARY")).toEqual([
			"On call: Ana Alves (API primary)",
			"On call: Ben Brook (API primary)",
			// Someone the directory no longer knows still has their shift shown.
			"On call: unknown (API primary)",
		])
	})

	it("gives each shift an id that stays the same on the next render", () => {
		const first = valuesOf(feed(), "UID")
		expect(new Set(first).size).toBe(3)
		expect(valuesOf(feed(), "UID")).toEqual(first)
	})

	it("is a calendar a client can parse: wrapped, CRLF line endings, a trailing line break", () => {
		const body = feed()
		expect(Str.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")(body)).toBe(true)
		expect(Str.endsWith("END:VCALENDAR\r\n")(body)).toBe(true)
		// No bare line feed anywhere: every break is CRLF.
		expect(Str.replaceAll("\r\n", "")(body)).not.toMatch(/[\r\n]/)
		expect(Arr.filter(lines(body), (line) => line === "BEGIN:VEVENT")).toHaveLength(3)
		expect(Arr.filter(lines(body), (line) => line === "END:VEVENT")).toHaveLength(3)
	})

	it("escapes a schedule name that holds calendar syntax", () => {
		const body = feed("Payments; cards, wallets\nEU")
		expect(valuesOf(body, "X-WR-CALNAME")).toEqual(["On call: Payments\\; cards\\, wallets\\nEU"])
	})
})

describe("iCalendar text", () => {
	it("escapes backslash, semicolon, comma and line breaks", () => {
		expect(icsText("a\\b;c,d\r\ne\nf")).toBe("a\\\\b\\;c\\,d\\ne\\nf")
	})

	it("formats a UTC date-time in the basic form", () => {
		expect(icsDateTime(at("2026-01-02T03:04:05Z"))).toBe("20260102T030405Z")
	})

	it("folds a long line at 75 octets without splitting a character, and unfolds to the original", () => {
		const long = `SUMMARY:${Str.repeat(60)("é")} on call for the checkout rotation this week`
		const folded = foldIcsLine(long)
		const physical = Str.split("\r\n")(folded)
		expect(physical.length).toBeGreaterThan(1)
		const octets = Arr.map(physical, (line) => new TextEncoder().encode(line).length)
		expect(Math.max(...octets)).toBeLessThanOrEqual(75)
		// Unfolding removes each CRLF and the single space after it.
		expect(Str.replaceAll("\r\n ", "")(folded)).toBe(long)
		expect(foldIcsLine("SUMMARY:short")).toBe("SUMMARY:short")
	})
})
