import { onCallAt } from "@maple/alerting-core/oncall"
import { OnCallOverride, UserId } from "@maple/domain/http"
import { Array as Arr, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { emptyLayer, type Form, type LayerDraft } from "../schedule-form/form"
import {
	draftConfigOf,
	draftCoverage,
	durationText,
	gapsOf,
	gapSummary,
	previewRange,
	type Interval,
} from "./schedule-coverage"

const HOUR = 3_600_000
const at = (iso: string) => Date.parse(iso)
const people = Schema.decodeUnknownSync(Schema.Array(UserId))
const decodeOverrides = Schema.decodeUnknownSync(Schema.Array(OnCallOverride))

const layer = (patch: Partial<LayerDraft>): LayerDraft => ({
	...emptyLayer(0, 0, at("2026-11-02T08:00:00Z"), "Europe/Berlin"),
	...patch,
})
const formOf = (layers: ReadonlyArray<LayerDraft>, timeZone = "Europe/Berlin"): Form => ({
	name: "Ops",
	description: "",
	timeZone,
	layers,
	nextKey: layers.length,
})

/** Every `stepMs` across the range, checks the preview's final lane against the server's `onCallAt`. */
const expectMatchesServer = (
	form: Form,
	overrides: ReadonlyArray<OnCallOverride>,
	range: Interval,
	stepMs: number,
) => {
	const config = Option.getOrThrow(draftConfigOf(form)).config
	const coverage = draftCoverage(form, overrides, range.startMs, range.endMs, range.startMs)
	const count = Math.floor((range.endMs - range.startMs) / stepMs)
	Arr.forEach(Arr.range(0, count - 1), (i) => {
		const ms = range.startMs + i * stepMs + 1
		const server = onCallAt(config, overrides, ms)
		const preview = Arr.findFirst(coverage.final, (s) => s.startMs <= ms && ms < s.endMs)
		const inGap = Arr.some(coverage.gaps, (g) => g.startMs <= ms && ms < g.endMs)
		expect(Option.getOrNull(Option.map(preview, (s) => s.userId))).toBe(
			server === null ? null : server.userId,
		)
		expect(inGap).toBe(server === null)
	})
}

describe("gapsOf", () => {
	it("returns the whole range when nothing covers it", () => {
		expect(gapsOf([], 0, 10)).toEqual([{ startMs: 0, endMs: 10 }])
	})
	it("returns no gaps when shifts cover the range end to end", () => {
		expect(
			gapsOf(
				[
					{ startMs: 5, endMs: 12 },
					{ startMs: -2, endMs: 5 },
				],
				0,
				10,
			),
		).toEqual([])
	})
	it("finds holes between, before and after shifts", () => {
		expect(
			gapsOf(
				[
					{ startMs: 2, endMs: 4 },
					{ startMs: 6, endMs: 8 },
				],
				0,
				10,
			),
		).toEqual([
			{ startMs: 0, endMs: 2 },
			{ startMs: 4, endMs: 6 },
			{ startMs: 8, endMs: 10 },
		])
	})
})

describe("draftCoverage", () => {
	const range = { startMs: at("2026-11-09T00:00:00Z"), endMs: at("2026-11-23T00:00:00Z") }

	it("cycles members at the daily handoff time", () => {
		const form = formOf([
			layer({
				participants: people(["ana", "ben", "chen"]),
				rotation: "daily",
				handoffTime: "09:00",
				startsAt: "2026-11-09T09:00",
			}),
		])
		const coverage = draftCoverage(form, [], at("2026-11-09T08:00:00Z"), at("2026-11-12T08:00:00Z"), 0)
		expect(Arr.map(coverage.final, (s) => s.userId)).toEqual(["ana", "ben", "chen"])
		// 09:00 Berlin is 08:00 UTC in November.
		expect(Arr.map(coverage.final, (s) => new Date(s.startMs).toISOString())).toEqual([
			"2026-11-09T08:00:00.000Z",
			"2026-11-10T08:00:00.000Z",
			"2026-11-11T08:00:00.000Z",
		])
		expect(coverage.gaps).toEqual([])
	})

	it("layers a business-hours layer over a weekly one and applies overrides, matching onCallAt", () => {
		const form = formOf([
			layer({ participants: people(["ana", "ben"]), rotation: "weekly", startsAt: "2026-11-02T09:00" }),
			layer({
				key: "l1",
				participants: people(["dev"]),
				rotation: "daily",
				startsAt: "2026-11-02T09:00",
				restrictions: [
					{
						key: "r0",
						weekdays: ["mon", "tue", "wed", "thu", "fri"],
						startTime: "09:00",
						endTime: "17:00",
					},
				],
			}),
		])
		const overrides = decodeOverrides([
			{
				id: "0b7f6a3e-1c2d-4e5f-8a9b-1c2d3e4f5a60",
				userId: "eve",
				startsAt: at("2026-11-12T10:00:00Z"),
				endsAt: at("2026-11-13T02:00:00Z"),
				createdAt: 1,
			},
		])
		const coverage = draftCoverage(form, overrides, range.startMs, range.endMs, range.startMs)
		expect(coverage.gaps).toEqual([])
		expect(Arr.some(coverage.final, (s) => s.userId === "eve")).toBe(true)
		expectMatchesServer(form, overrides, range, HOUR / 2)
	})

	it("reports restriction holes as gaps that match onCallAt being null", () => {
		const form = formOf([
			layer({
				participants: people(["ana"]),
				rotation: "weekly",
				startsAt: "2026-11-02T09:00",
				restrictions: [
					{
						key: "r0",
						weekdays: ["mon", "tue", "wed", "thu", "fri"],
						startTime: "08:00",
						endTime: "20:00",
					},
				],
			}),
		])
		const coverage = draftCoverage(form, [], range.startMs, range.endMs, range.startMs)
		// Nights plus the two weekends.
		expect(coverage.gaps.length).toBeGreaterThan(8)
		expectMatchesServer(form, [], range, HOUR / 2)
	})

	it("hands off at local 09:00 across the October DST change", () => {
		const form = formOf([
			layer({
				participants: people(["ana", "ben"]),
				rotation: "daily",
				handoffTime: "09:00",
				startsAt: "2026-10-23T09:00",
			}),
		])
		const dst = { startMs: at("2026-10-22T22:00:00Z"), endMs: at("2026-10-28T23:00:00Z") }
		const coverage = draftCoverage(form, [], dst.startMs, dst.endMs, dst.startMs)
		const sunday = Arr.findFirst(coverage.final, (s) => s.startMs === at("2026-10-25T07:00:00Z"))
		// Sat 09:00 CEST (07:00Z) to Sun 09:00 CET (08:00Z) is 25 hours.
		const saturday = Arr.findFirst(coverage.final, (s) => s.startMs === at("2026-10-24T07:00:00Z"))
		expect(Option.map(saturday, (s) => s.endMs - s.startMs)).toEqual(Option.some(25 * HOUR))
		expect(Option.isNone(sunday)).toBe(true)
		expectMatchesServer(form, [], dst, HOUR / 4)
	})

	it("treats a layer with no members as not previewable and the schedule as all gap", () => {
		const form = formOf([layer({ participants: [] })])
		const coverage = draftCoverage(form, [], range.startMs, range.endMs, range.startMs)
		expect(Option.isNone(coverage.layers[0] ?? Option.some([]))).toBe(true)
		expect(coverage.gaps).toEqual([{ startMs: range.startMs, endMs: range.endMs }])
	})

	it("keeps lanes aligned with the draft when a middle layer cannot preview", () => {
		const form = formOf([
			layer({ participants: people(["ana"]), startsAt: "2026-11-02T09:00" }),
			layer({ key: "l1", participants: [] }),
			layer({ key: "l2", participants: people(["ben"]), rotation: "custom", lengthHours: "nope" }),
		])
		const coverage = draftCoverage(form, [], range.startMs, range.endMs, range.startMs)
		expect(Arr.map(coverage.layers, Option.isSome)).toEqual([true, false, false])
	})

	it("counts gaps only from now, and a future start leaves a gap before it", () => {
		const form = formOf([layer({ participants: people(["ana"]), startsAt: "2026-11-12T09:00" })])
		const nowMs = at("2026-11-10T12:00:00Z")
		const coverage = draftCoverage(form, [], range.startMs, range.endMs, nowMs)
		expect(coverage.gaps).toEqual([{ startMs: nowMs, endMs: at("2026-11-12T08:00:00Z") }])
	})
})

describe("previewRange", () => {
	it("spans whole local days, so a DST week is an hour longer", () => {
		const week = previewRange(at("2026-10-21T10:00:00Z"), "Europe/Berlin", 0, 7)
		expect(week.startMs).toBe(at("2026-10-20T22:00:00Z"))
		expect(week.endMs - week.startMs).toBe(7 * 24 * HOUR + HOUR)
	})
})

describe("gapSummary", () => {
	it("says covered when there are no gaps", () => {
		expect(gapSummary([], "Europe/Berlin", 0, 14)).toBe("Covered for the next 14 days")
	})
	it("counts gaps and names the longest in the schedule's zone", () => {
		const gaps = [
			{ startMs: at("2026-11-19T23:00:00Z"), endMs: at("2026-11-20T01:00:00Z") },
			{ startMs: at("2026-11-20T23:00:00Z"), endMs: at("2026-11-21T15:00:00Z") },
		]
		expect(gapSummary(gaps, "Europe/Berlin", 0, 14)).toBe(
			"2 gaps in the next 14 days, longest 16h (Sat 21 Nov 00:00 to 16:00)",
		)
	})
	it("formats durations", () => {
		expect(durationText(90 * 60_000)).toBe("1h 30m")
		expect(durationText(76 * HOUR)).toBe("3d 4h")
	})
})
