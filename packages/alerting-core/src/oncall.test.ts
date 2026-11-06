import { Array as Arr, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { OnCallOverride, OnCallScheduleConfig } from "@maple/domain/http"
import { ONCALL_LOOKAROUND_MS, onCallAt, renderOnCall, type OnCallShift } from "./oncall"

const HOUR = 3_600_000
const at = (iso: string) => Date.parse(iso)
const decodeConfig = Schema.decodeUnknownSync(OnCallScheduleConfig)
const decodeOverrides = Schema.decodeUnknownSync(Schema.Array(OnCallOverride))

// Monday 2026-03-02 09:00 Europe/Berlin (CET).
const WEEKLY_ANCHOR = at("2026-03-02T08:00:00Z")

const weeklyLayer = {
	name: "Primary",
	participants: ["ana", "ben", "chen"],
	rotation: { kind: "weekly", handoffWeekday: "mon", handoffTime: "09:00" },
	startsAt: WEEKLY_ANCHOR,
}
const weekly = decodeConfig({ timeZone: "Europe/Berlin", layers: [weeklyLayer] })

const who = (shift: OnCallShift | null) => (shift === null ? null : shift.userId)
const sourceKey = (shift: OnCallShift) =>
	shift.source.kind === "override"
		? `override:${shift.source.overrideId}`
		: `layer:${shift.source.layerIndex}`
const span = (shift: OnCallShift | null) =>
	shift === null
		? null
		: { start: new Date(shift.startMs).toISOString(), end: new Date(shift.endMs).toISOString() }

describe("weekly rotation", () => {
	it("hands off every Monday at 09:00 local in rotation order", () => {
		expect(who(onCallAt(weekly, [], at("2026-03-02T08:00:00Z")))).toBe("ana")
		expect(who(onCallAt(weekly, [], at("2026-03-09T07:59:00Z")))).toBe("ana")
		expect(who(onCallAt(weekly, [], at("2026-03-09T08:00:00Z")))).toBe("ben")
		expect(who(onCallAt(weekly, [], at("2026-03-18T12:00:00Z")))).toBe("chen")
		expect(who(onCallAt(weekly, [], at("2026-03-25T12:00:00Z")))).toBe("ana")
	})

	it("is empty before the layer starts", () => {
		expect(onCallAt(weekly, [], WEEKLY_ANCHOR - 1)).toBeNull()
	})

	it("keeps the 09:00 handoff across spring forward, giving a 167h shift", () => {
		const shift = onCallAt(weekly, [], at("2026-03-29T12:00:00Z"))
		expect(who(shift)).toBe("ana")
		expect(span(shift)).toEqual({ start: "2026-03-23T08:00:00.000Z", end: "2026-03-30T07:00:00.000Z" })
		expect(shift === null ? 0 : (shift.endMs - shift.startMs) / HOUR).toBe(167)
		expect(who(onCallAt(weekly, [], at("2026-03-30T07:00:00Z")))).toBe("ben")
	})

	it("keeps the 09:00 handoff across fall back, giving a 169h shift", () => {
		const shift = onCallAt(weekly, [], at("2026-10-25T12:00:00Z"))
		// 33 weeks after the anchor, so the rotation is back at Ana.
		expect(who(shift)).toBe("ana")
		expect(span(shift)).toEqual({ start: "2026-10-19T07:00:00.000Z", end: "2026-10-26T08:00:00.000Z" })
		expect(shift === null ? 0 : (shift.endMs - shift.startMs) / HOUR).toBe(169)
	})
})

describe("daily and custom rotations", () => {
	it("hands off daily at the local handoff time", () => {
		const daily = decodeConfig({
			timeZone: "America/New_York",
			layers: [
				{
					name: "Daily",
					participants: ["ana", "ben"],
					rotation: { kind: "daily", handoffTime: "08:30" },
					startsAt: at("2026-01-05T13:30:00Z"),
				},
			],
		})
		expect(who(onCallAt(daily, [], at("2026-01-06T13:29:00Z")))).toBe("ana")
		const second = onCallAt(daily, [], at("2026-01-06T13:30:00Z"))
		expect(who(second)).toBe("ben")
		expect(span(second)).toEqual({ start: "2026-01-06T13:30:00.000Z", end: "2026-01-07T13:30:00.000Z" })
		// After the March 8 change 08:30 EDT is 12:30Z.
		expect(span(onCallAt(daily, [], at("2026-03-10T00:00:00Z")))).toEqual({
			start: "2026-03-09T12:30:00.000Z",
			end: "2026-03-10T12:30:00.000Z",
		})
	})

	it("runs custom rotations in elapsed hours from the anchor, ignoring DST", () => {
		const custom = decodeConfig({
			timeZone: "Europe/Berlin",
			layers: [
				{
					name: "12h",
					participants: ["ana", "ben", "chen"],
					rotation: { kind: "custom", lengthHours: 12 },
					startsAt: at("2026-03-28T20:00:00Z"),
				},
			],
		})
		expect(who(onCallAt(custom, [], at("2026-03-28T21:00:00Z")))).toBe("ana")
		const second = onCallAt(custom, [], at("2026-03-29T10:00:00Z"))
		expect(who(second)).toBe("ben")
		expect(span(second)).toEqual({ start: "2026-03-29T08:00:00.000Z", end: "2026-03-29T20:00:00.000Z" })
		expect(who(onCallAt(custom, [], at("2026-03-30T07:00:00Z")))).toBe("chen")
		expect(who(onCallAt(custom, [], at("2026-03-30T09:00:00Z")))).toBe("ana")
	})
})

describe("layers and restrictions", () => {
	const layered = decodeConfig({
		timeZone: "Europe/Berlin",
		layers: [
			weeklyLayer,
			{
				name: "Weekend",
				participants: ["dana"],
				rotation: { kind: "weekly", handoffWeekday: "mon", handoffTime: "09:00" },
				startsAt: WEEKLY_ANCHOR,
				restrictions: [{ weekdays: ["sat", "sun"], startTime: "00:00", endTime: "00:00" }],
			},
		],
	})

	it("lets the weekend layer win on weekends and the base layer elsewhere", () => {
		const weekday = onCallAt(layered, [], at("2026-03-04T12:00:00Z"))
		expect(weekday?.source).toEqual({ kind: "layer", layerIndex: 0 })
		expect(who(weekday)).toBe("ana")

		const weekend = onCallAt(layered, [], at("2026-03-07T12:00:00Z"))
		expect(weekend?.source).toEqual({ kind: "layer", layerIndex: 1 })
		expect(who(weekend)).toBe("dana")
		expect(span(weekend)).toEqual({ start: "2026-03-06T23:00:00.000Z", end: "2026-03-08T23:00:00.000Z" })

		// Monday before the 09:00 handoff falls back to the base layer.
		const monday = onCallAt(layered, [], at("2026-03-09T05:00:00Z"))
		expect(who(monday)).toBe("ana")
		expect(span(monday)).toEqual({ start: "2026-03-08T23:00:00.000Z", end: "2026-03-09T08:00:00.000Z" })
	})

	it("renders each layer's own shifts after restrictions", () => {
		const render = renderOnCall(layered, [], at("2026-03-02T08:00:00Z"), at("2026-03-16T08:00:00Z"))
		expect(Arr.map(render.layers[1] ?? [], span)).toEqual([
			{ start: "2026-03-06T23:00:00.000Z", end: "2026-03-08T23:00:00.000Z" },
			{ start: "2026-03-13T23:00:00.000Z", end: "2026-03-15T23:00:00.000Z" },
		])
		expect(Arr.map(render.final, who)).toEqual(["ana", "dana", "ana", "ben", "dana", "ben"])
	})

	const nights = decodeConfig({
		timeZone: "UTC",
		layers: [
			{
				name: "Nights",
				participants: ["ana"],
				rotation: { kind: "daily", handoffTime: "00:00" },
				startsAt: at("2026-01-01T00:00:00Z"),
				restrictions: [
					{
						weekdays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
						startTime: "22:00",
						endTime: "06:00",
					},
				],
			},
		],
	})

	it("covers a restriction window that crosses midnight", () => {
		const night = onCallAt(nights, [], at("2026-01-06T03:00:00Z"))
		expect(who(night)).toBe("ana")
		// Pieces of consecutive daily shifts for the same user merge into one window.
		expect(span(night)).toEqual({ start: "2026-01-05T22:00:00.000Z", end: "2026-01-06T06:00:00.000Z" })
	})

	it("reports a gap where no layer is active", () => {
		expect(onCallAt(nights, [], at("2026-01-06T12:00:00Z"))).toBeNull()
		const render = renderOnCall(nights, [], at("2026-01-06T00:00:00Z"), at("2026-01-07T00:00:00Z"))
		expect(Arr.map(render.final, span)).toEqual([
			{ start: "2026-01-06T00:00:00.000Z", end: "2026-01-06T06:00:00.000Z" },
			{ start: "2026-01-06T22:00:00.000Z", end: "2026-01-07T00:00:00.000Z" },
		])
	})
})

describe("overrides", () => {
	const dan = {
		id: "ovr_dan",
		userId: "dan",
		startsAt: at("2026-03-04T10:00:00Z"),
		endsAt: at("2026-03-04T14:00:00Z"),
		createdAt: 1,
	}
	const eve = {
		id: "ovr_eve",
		userId: "eve",
		startsAt: at("2026-03-04T12:00:00Z"),
		endsAt: at("2026-03-04T16:00:00Z"),
		createdAt: 2,
	}

	it("beats every layer and splits the shift it sits inside", () => {
		const overrides = decodeOverrides([dan])
		const covered = onCallAt(weekly, overrides, at("2026-03-04T12:00:00Z"))
		expect(who(covered)).toBe("dan")
		expect(covered?.source).toEqual({ kind: "override", overrideId: "ovr_dan" })

		const render = renderOnCall(weekly, overrides, WEEKLY_ANCHOR, at("2026-03-09T08:00:00Z"))
		expect(Arr.map(render.final, (s) => ({ user: who(s), ...span(s) }))).toEqual([
			{ user: "ana", start: "2026-03-02T08:00:00.000Z", end: "2026-03-04T10:00:00.000Z" },
			{ user: "dan", start: "2026-03-04T10:00:00.000Z", end: "2026-03-04T14:00:00.000Z" },
			{ user: "ana", start: "2026-03-04T14:00:00.000Z", end: "2026-03-09T08:00:00.000Z" },
		])
	})

	it("resolves overlapping overrides to the most recently created", () => {
		const newerEve = decodeOverrides([dan, eve])
		expect(who(onCallAt(weekly, newerEve, at("2026-03-04T11:00:00Z")))).toBe("dan")
		expect(who(onCallAt(weekly, newerEve, at("2026-03-04T13:00:00Z")))).toBe("eve")

		const olderEve = decodeOverrides([dan, { ...eve, createdAt: 0 }])
		expect(who(onCallAt(weekly, olderEve, at("2026-03-04T13:00:00Z")))).toBe("dan")
		expect(who(onCallAt(weekly, olderEve, at("2026-03-04T15:00:00Z")))).toBe("eve")
	})

	it("fills a gap", () => {
		const nights = decodeConfig({
			timeZone: "UTC",
			layers: [
				{
					name: "Nights",
					participants: ["ana"],
					rotation: { kind: "daily", handoffTime: "00:00" },
					startsAt: 0,
					restrictions: [{ weekdays: ["tue"], startTime: "22:00", endTime: "06:00" }],
				},
			],
		})
		const overrides = decodeOverrides([{ ...dan, startsAt: at("2026-03-04T10:00:00Z") }])
		expect(onCallAt(nights, [], at("2026-03-04T12:00:00Z"))).toBeNull()
		expect(who(onCallAt(nights, overrides, at("2026-03-04T12:00:00Z")))).toBe("dan")
	})
})

describe("render and onCallAt agree", () => {
	it("matches at instants sampled every 37 minutes over 60 days", () => {
		const config = decodeConfig({
			timeZone: "Europe/Berlin",
			layers: [
				weeklyLayer,
				{
					name: "Evenings",
					participants: ["dana", "eli"],
					rotation: { kind: "daily", handoffTime: "18:00" },
					startsAt: at("2026-03-10T17:00:00Z"),
					restrictions: [{ weekdays: ["mon", "wed", "fri"], startTime: "18:00", endTime: "02:00" }],
				},
				{
					name: "Saturday mornings",
					participants: ["fay"],
					rotation: { kind: "custom", lengthHours: 7 },
					startsAt: at("2026-03-01T00:00:00Z"),
					restrictions: [{ weekdays: ["sat"], startTime: "06:00", endTime: "12:00" }],
				},
			],
		})
		const overrides = decodeOverrides([
			{
				id: "o1",
				userId: "gus",
				startsAt: at("2026-03-20T10:00:00Z"),
				endsAt: at("2026-03-22T10:00:00Z"),
				createdAt: 1,
			},
			{
				id: "o2",
				userId: "hal",
				startsAt: at("2026-03-21T00:00:00Z"),
				endsAt: at("2026-03-21T06:00:00Z"),
				createdAt: 2,
			},
			{
				id: "o3",
				userId: "ana",
				startsAt: at("2026-04-02T00:00:00Z"),
				endsAt: at("2026-04-03T00:00:00Z"),
				createdAt: 3,
			},
		])
		// Starts before the base layer, so the first sampled day is a gap.
		const fromMs = at("2026-03-01T00:00:00Z")
		const toMs = fromMs + 60 * 24 * HOUR
		const render = renderOnCall(config, overrides, fromMs, toMs)
		const samples = Arr.makeBy(
			Math.floor((toMs - fromMs) / (37 * 60_000)),
			(i) => fromMs + i * 37 * 60_000,
		)

		const mismatches = Arr.filter(samples, (t) => {
			const expected = Arr.findFirst(render.final, (s) => s.startMs <= t && t < s.endMs).pipe(
				Option.getOrNull,
			)
			const actual = onCallAt(config, overrides, t)
			if (expected === null || actual === null) return expected !== actual
			const sameOwner = expected.userId === actual.userId && sourceKey(expected) === sourceKey(actual)
			// Bounds agree whenever neither window clips the shift.
			const unclipped =
				expected.startMs > Math.max(fromMs, t - ONCALL_LOOKAROUND_MS) &&
				expected.endMs < Math.min(toMs, t + ONCALL_LOOKAROUND_MS)
			const sameBounds =
				!unclipped || (expected.startMs === actual.startMs && expected.endMs === actual.endMs)
			return !(sameOwner && sameBounds && actual.startMs <= t && t < actual.endMs)
		})
		expect(mismatches).toEqual([])
		// The sample exercises gaps, every layer and the overrides.
		const owners = new Set(Arr.map(samples, (t) => who(onCallAt(config, overrides, t))))
		expect(owners).toEqual(new Set([null, "ana", "ben", "chen", "dana", "eli", "fay", "gus", "hal"]))
	})
})

describe("render caps", () => {
	it("clamps the range to 90 days", () => {
		const render = renderOnCall(weekly, [], WEEKLY_ANCHOR, WEEKLY_ANCHOR + 400 * 24 * HOUR)
		const last = Arr.last(render.final).pipe(Option.getOrNull)
		expect(last === null ? 0 : last.endMs).toBe(WEEKLY_ANCHOR + 90 * 24 * HOUR)
	})

	it("returns nothing for an empty range", () => {
		expect(renderOnCall(weekly, [], WEEKLY_ANCHOR, WEEKLY_ANCHOR).final).toEqual([])
	})
})

describe("schema", () => {
	const decodes = (input: unknown) => Option.isSome(Schema.decodeUnknownOption(OnCallScheduleConfig)(input))

	it("accepts a valid config", () => {
		expect(decodes({ timeZone: "Europe/Berlin", layers: [weeklyLayer] })).toBe(true)
	})

	it("rejects an unknown time zone", () => {
		expect(decodes({ timeZone: "Mars/Olympus", layers: [weeklyLayer] })).toBe(false)
	})

	it("rejects a malformed local time", () => {
		const layer = {
			...weeklyLayer,
			restrictions: [{ weekdays: ["mon"], startTime: "09:00", endTime: "24:00" }],
		}
		expect(decodes({ timeZone: "UTC", layers: [layer] })).toBe(false)
		expect(
			decodes({
				timeZone: "UTC",
				layers: [{ ...weeklyLayer, rotation: { kind: "daily", handoffTime: "9:00" } }],
			}),
		).toBe(false)
	})

	it("rejects empty participants and empty layers", () => {
		expect(decodes({ timeZone: "UTC", layers: [{ ...weeklyLayer, participants: [] }] })).toBe(false)
		expect(decodes({ timeZone: "UTC", layers: [] })).toBe(false)
	})

	it("rejects an override that ends before it starts", () => {
		const decodeOverride = Schema.decodeUnknownOption(OnCallOverride)
		expect(
			Option.isNone(decodeOverride({ id: "o", userId: "ana", startsAt: 10, endsAt: 10, createdAt: 0 })),
		).toBe(true)
	})
})
