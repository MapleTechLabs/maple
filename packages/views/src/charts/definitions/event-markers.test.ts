import { Array as Arr } from "effect"
import { describe, expect, test } from "vitest"
import { placeMarkersInWindow } from "./event-markers"

// A marker lands where it happened inside the window; a band keeps the part that overlaps it.

const buckets = ["2026-11-01T09:00:00.000Z", "2026-11-01T10:00:00.000Z", "2026-11-01T11:00:00.000Z"]

const placedAt = (marker: Parameters<typeof placeMarkersInWindow>[0][number]) =>
	Arr.map(placeMarkersInWindow([marker], buckets), (entry) => [
		entry.x.toISOString(),
		entry.x2?.toISOString() ?? null,
	])

describe("event markers in the window", () => {
	test("a band that starts before the window shades from the window's start", () => {
		expect(
			placedAt({
				id: "incident",
				at: "2026-11-01T08:55:00.000Z",
				endsAt: "2026-11-01T10:10:00.000Z",
				label: "Incident",
				tone: "crit",
			}),
		).toEqual([["2026-11-01T09:00:00.000Z", "2026-11-01T10:10:00.000Z"]])
	})

	test("a band past the window's end stops at it, and one wholly outside is dropped", () => {
		expect(
			placedAt({
				id: "incident",
				at: "2026-11-01T11:30:00.000Z",
				endsAt: "2026-11-01T13:00:00.000Z",
				label: "Incident",
				tone: "crit",
			}),
		).toEqual([["2026-11-01T11:30:00.000Z", "2026-11-01T12:00:00.000Z"]])
		expect(
			placedAt({
				id: "incident",
				at: "2026-11-01T06:00:00.000Z",
				endsAt: "2026-11-01T07:00:00.000Z",
				label: "Incident",
				tone: "crit",
			}),
		).toEqual([])
	})

	test("a line outside the window is dropped", () => {
		expect(
			placedAt({ id: "fixed", at: "2026-11-01T10:05:00.000Z", label: "Fixed", tone: "neutral" }),
		).toEqual([["2026-11-01T10:05:00.000Z", null]])
		expect(
			placedAt({ id: "fixed", at: "2026-11-01T13:00:00.000Z", label: "Fixed", tone: "neutral" }),
		).toEqual([])
	})
})

describe("event markers against an explicit extent", () => {
	test("a marker past the bars' extent is dropped, and one bucket keeps a band as a line", () => {
		const marker = {
			id: "fixed",
			at: "2026-11-01T11:45:00.000Z",
			label: "Fixed",
			tone: "neutral" as const,
		}
		const extent = {
			startMs: Date.parse("2026-11-01T08:30:00.000Z"),
			endMs: Date.parse("2026-11-01T11:30:00.000Z"),
		}
		expect(placeMarkersInWindow([marker], buckets, extent)).toEqual([])
		const band = placeMarkersInWindow(
			[
				{
					id: "incident",
					at: "2026-11-01T09:00:00.000Z",
					endsAt: "2026-11-01T10:00:00.000Z",
					label: "Incident",
					tone: "crit",
				},
			],
			["2026-11-01T09:00:00.000Z"],
		)
		expect(Arr.map(band, (entry) => [entry.x.toISOString(), entry.x2 ?? null])).toEqual([
			["2026-11-01T09:00:00.000Z", null],
		])
	})
})
