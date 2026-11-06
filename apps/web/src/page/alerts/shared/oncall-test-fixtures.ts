import {
	encodePublicId,
	V2AlertIncidentEvent,
	V2EscalationChain,
	V2OnCallOverride,
	V2OnCallSchedule,
	V2OnCallShifts,
} from "@maple/domain/http/v2"
import { UserId } from "@maple/domain/http"
import { zonedDateParts, zonedPartsToEpochMs } from "@maple/query-engine/datetime"
import { Array as Arr, Option, Order, Schema, String as Str } from "effect"
import type { OrgMember } from "./org-members"
import { isoMs, msIso } from "./time"

// On-call schedules, members, shifts and overrides for the scene tests and `/lab/oncall`. The
// shifts come from a small wall-clock generator, so a DST week reads the way the API renders it.

const pad = (n: number) => Str.padStart(12, "0")(String(n))
export const scheduleUuid = (n: number) => `0199a00f-0000-7000-8000-${pad(n)}`
export const overrideUuid = (n: number) => `0199a010-0000-7000-8000-${pad(n)}`
export const schedulePublicId = (n: number) => encodePublicId("onc", scheduleUuid(n))

/** Tue 10 Nov 2026, 10:30 UTC: the lab's and the tests' clock. */
export const ONCALL_NOW = isoMs("2026-11-10T10:30:00.000Z")
/** Thu 22 Oct 2026, 10:00 UTC: a week whose Sunday (25 Oct) Berlin falls back an hour. */
export const DST_NOW = isoMs("2026-10-22T10:00:00.000Z")

const NAMES = [
	"Ben Brook",
	"Dana Kim",
	"Priya Raman",
	"Lukas Weber",
	"Sofia Alvarez",
	"Mei Chen",
	"Omar Haddad",
	"Ana Souza",
] as const

export const memberId = (index: number) => `user_2oncall${Str.padStart(4, "0")(String(index))}`

export const oncallMembers: ReadonlyArray<OrgMember> = Arr.map(NAMES, (name, index) => ({
	userId: Schema.decodeSync(UserId)(memberId(index)),
	name,
	email: `${Str.toLowerCase(Str.replaceAll(" ", ".")(name))}@acme.test`,
	imageUrl: "",
}))

// A tiny on-call engine over the zone's wall clock.

type Segment = Readonly<{ userId: string; startMs: number; endMs: number }>
type Source = Readonly<{ kind: "layer"; layer_index: number } | { kind: "override"; override_id: string }>
type Shift = Segment & Readonly<{ source: Source }>

const weekdayFormatter = (timeZone: string) =>
	new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" })

/** `hour`:00 on the zone's day `dayOffset` days after the one containing `ms`. */
const wallClock = (ms: number, timeZone: string, dayOffset: number, hour: number): number => {
	const parts = zonedDateParts(ms, timeZone)
	return zonedPartsToEpochMs({ ...parts, day: parts.day + dayOffset, hour, minute: 0, second: 0 }, timeZone)
}

const DAYS = Arr.range(-8, 16)
const DAY_MS = 86_400_000

/** Whose turn a shift starting at `startMs` is: counted from the epoch, so any range agrees. */
const turnOf = (startMs: number, periodMs: number) => Math.floor((startMs + 43_200_000) / periodMs)

/** Hand-offs at `hour` on the days `isHandoffDay` keeps, people taking turns from `fromMs`'s week. */
const rotation = (
	participants: ReadonlyArray<string>,
	timeZone: string,
	fromMs: number,
	hour: number,
	isHandoffDay: (weekday: string) => boolean,
	periodMs: number,
): ReadonlyArray<Segment> => {
	const weekday = weekdayFormatter(timeZone)
	const edges = Arr.filter(
		Arr.map(DAYS, (day) => wallClock(fromMs, timeZone, day, hour)),
		(at) => isHandoffDay(weekday.format(at)),
	)
	return Arr.flatMap(edges, (startMs, index) => {
		const endMs = edges[index + 1]
		const userId = participants[turnOf(startMs, periodMs) % participants.length]
		return endMs === undefined || userId === undefined ? [] : [{ userId, startMs, endMs }]
	})
}

/** A window from `startHour` to `endHour` the next morning on each kept day, people alternating. */
const nights = (
	participants: ReadonlyArray<string>,
	timeZone: string,
	fromMs: number,
	startHour: number,
	endHour: number,
	isDay: (weekday: string) => boolean,
): ReadonlyArray<Segment> => {
	const weekday = weekdayFormatter(timeZone)
	return Arr.flatMap(DAYS, (day) => {
		const startMs = wallClock(fromMs, timeZone, day, startHour)
		const userId = participants[turnOf(startMs, DAY_MS) % participants.length]
		return isDay(weekday.format(startMs)) && userId !== undefined
			? [{ userId, startMs, endMs: wallClock(fromMs, timeZone, day + 1, endHour) }]
			: []
	})
}

const clip = <S extends Segment>(
	segments: ReadonlyArray<S>,
	fromMs: number,
	toMs: number,
): ReadonlyArray<S> =>
	Arr.flatMap(segments, (segment) => {
		const startMs = Math.max(segment.startMs, fromMs)
		const endMs = Math.min(segment.endMs, toMs)
		return endMs > startMs ? [{ ...segment, startMs, endMs }] : []
	})

const covering = (segments: ReadonlyArray<Segment>, at: number) =>
	Arr.findLast(segments, (segment) => segment.startMs <= at && at < segment.endMs)

const sameSource = (a: Source, b: Source): boolean =>
	a.kind === "layer"
		? b.kind === "layer" && a.layer_index === b.layer_index
		: b.kind === "override" && a.override_id === b.override_id

/** Layers stacked bottom first, the top one with someone on call winning, overrides over all. */
const flatten = (
	layers: ReadonlyArray<ReadonlyArray<Segment>>,
	overrides: ReadonlyArray<Segment & Readonly<{ id: string }>>,
	fromMs: number,
	toMs: number,
): ReadonlyArray<Shift> => {
	const edges = Arr.sort(
		Arr.dedupe([
			fromMs,
			toMs,
			...Arr.flatMap([...layers, overrides], (segments) =>
				Arr.flatMap(segments, (segment) => [segment.startMs, segment.endMs]),
			),
		]),
		Order.Number,
	)
	const pieces = Arr.flatMap(edges, (startMs, index): ReadonlyArray<Shift> => {
		const endMs = edges[index + 1]
		if (endMs === undefined || startMs < fromMs || endMs > toMs) return []
		const mid = (startMs + endMs) / 2
		const override = Arr.findLast(overrides, (segment) => segment.startMs <= mid && mid < segment.endMs)
		if (Option.isSome(override))
			return [
				{
					userId: override.value.userId,
					startMs,
					endMs,
					source: { kind: "override", override_id: override.value.id },
				},
			]
		const top = Arr.findLast(
			Arr.map(layers, (segments, layerIndex) => ({ layerIndex, hit: covering(segments, mid) })),
			({ hit }) => Option.isSome(hit),
		)
		return Option.match(top, {
			onNone: () => [],
			onSome: ({ layerIndex, hit }) =>
				Option.match(hit, {
					onNone: () => [],
					onSome: (segment) => [
						{
							userId: segment.userId,
							startMs,
							endMs,
							source: { kind: "layer", layer_index: layerIndex },
						},
					],
				}),
		})
	})
	const none: ReadonlyArray<Shift> = []
	return Arr.reduce(pieces, none, (merged, piece) => {
		const last = merged[merged.length - 1]
		return last !== undefined &&
			last.endMs === piece.startMs &&
			last.userId === piece.userId &&
			sameSource(last.source, piece.source)
			? [...merged.slice(0, -1), { ...last, endMs: piece.endMs }]
			: [...merged, piece]
	})
}

// WIRE

const iso = (ms: number) => msIso(ms)
const decodeSchedule = Schema.decodeUnknownSync(V2OnCallSchedule)
const decodeShifts = Schema.decodeUnknownSync(V2OnCallShifts)
const decodeOverride = Schema.decodeUnknownSync(V2OnCallOverride)
const decodeEvent = Schema.decodeUnknownSync(V2AlertIncidentEvent)

const wireShift = (shift: Shift) => ({
	user_id: shift.userId,
	starts_at: iso(shift.startMs),
	ends_at: iso(shift.endMs),
	source:
		shift.source.kind === "layer"
			? shift.source
			: { kind: "override", override_id: encodePublicId("ovr", shift.source.override_id) },
})

/** One fixture schedule: its layers as the API holds them, and how to render its shifts. */
type Spec = Readonly<{
	n: number
	name: string
	timeZone: string
	layers: ReadonlyArray<unknown>
	segments: (fromMs: number) => ReadonlyArray<ReadonlyArray<Segment>>
	overrides: (nowMs: number) => ReadonlyArray<Segment & Readonly<{ id: string }>>
}>

const m = (index: number) => memberId(index)
const isWeekday = (day: string) => day !== "Sat" && day !== "Sun"
const isWeekend = (day: string) => day === "Sat" || day === "Sun"

const checkout: Spec = {
	n: 1,
	name: "Checkout primary",
	timeZone: "Europe/Berlin",
	layers: [
		{
			name: "Primary",
			participants: [m(0), m(1), m(2)],
			rotation: { kind: "weekly", handoff_weekday: "mon", handoff_time: "09:00" },
			starts_at: "2026-10-05T07:00:00.000Z",
		},
		{
			name: "Daytime backup",
			participants: [m(3), m(4)],
			rotation: { kind: "daily", handoff_time: "09:00" },
			starts_at: "2026-10-05T07:00:00.000Z",
			restrictions: [
				{ weekdays: ["mon", "tue", "wed", "thu", "fri"], start_time: "09:00", end_time: "17:00" },
			],
		},
		{
			name: "Weeknights",
			participants: [m(5), m(6)],
			rotation: { kind: "daily", handoff_time: "18:00" },
			starts_at: "2026-10-05T16:00:00.000Z",
			restrictions: [
				{ weekdays: ["mon", "tue", "wed", "thu", "fri"], start_time: "18:00", end_time: "08:00" },
			],
		},
	],
	segments: (fromMs) => [
		rotation([m(0), m(1), m(2)], "Europe/Berlin", fromMs, 9, (day) => day === "Mon", 7 * DAY_MS),
		Arr.filter(
			Arr.map(
				rotation([m(3), m(4)], "Europe/Berlin", fromMs, 9, () => true, DAY_MS),
				(segment) => ({
					...segment,
					endMs: segment.startMs + 8 * 3_600_000,
				}),
			),
			(segment) => isWeekday(weekdayFormatter("Europe/Berlin").format(segment.startMs)),
		),
		nights([m(5), m(6)], "Europe/Berlin", fromMs, 18, 8, isWeekday),
	],
	overrides: (nowMs) => [
		{
			id: overrideUuid(1),
			userId: m(7),
			startMs: wallClock(nowMs, "Europe/Berlin", 1, 18),
			endMs: wallClock(nowMs, "Europe/Berlin", 2, 8),
		},
		{
			id: overrideUuid(2),
			userId: m(1),
			startMs: wallClock(nowMs, "Europe/Berlin", 3, 12),
			endMs: wallClock(nowMs, "Europe/Berlin", 4, 12),
		},
	],
}

const longName: Spec = {
	n: 2,
	name: "Payments platform and ledger reconciliation, North America business hours rotation",
	timeZone: "America/New_York",
	layers: [
		{
			name: "Business hours",
			participants: [m(4), m(2), m(6)],
			rotation: { kind: "custom", length_hours: 12 },
			starts_at: "2026-11-02T13:00:00.000Z",
		},
	],
	segments: (fromMs) => [rotation([m(4), m(2), m(6)], "America/New_York", fromMs, 9, () => true, DAY_MS)],
	overrides: () => [],
}

/** Weekends only: on a weekday nobody is on call. */
const weekends: Spec = {
	n: 3,
	name: "Weekend coverage",
	timeZone: "UTC",
	layers: [
		{
			name: "Weekends",
			participants: [m(7), m(3)],
			rotation: { kind: "weekly", handoff_weekday: "sat", handoff_time: "00:00" },
			starts_at: "2026-10-03T00:00:00.000Z",
			restrictions: [{ weekdays: ["sat", "sun"], start_time: "00:00", end_time: "00:00" }],
		},
	],
	segments: (fromMs) => [
		Arr.filter(
			rotation([m(7), m(3)], "UTC", fromMs, 0, () => true, DAY_MS),
			(segment) => isWeekend(weekdayFormatter("UTC").format(segment.startMs)),
		),
	],
	overrides: () => [],
}

const SPECS: ReadonlyArray<Spec> = [checkout, longName, weekends]

const WEEK_MS = 7 * 86_400_000

/** The schedule as `GET /oncall_schedules` returns it, with who is on call at `nowMs`. */
const scheduleOf = (spec: Spec, nowMs: number): V2OnCallSchedule => {
	const final = flatten(
		spec.segments(nowMs - WEEK_MS),
		spec.overrides(nowMs),
		nowMs - WEEK_MS,
		nowMs + WEEK_MS,
	)
	const current = Arr.findFirst(final, (shift) => shift.startMs <= nowMs && nowMs < shift.endMs)
	return decodeSchedule({
		id: encodePublicId("onc", scheduleUuid(spec.n)),
		object: "oncall_schedule",
		name: spec.name,
		description: null,
		time_zone: spec.timeZone,
		layers: spec.layers,
		on_call_now: Option.getOrNull(
			Option.map(current, (shift) => ({
				user_id: shift.userId,
				starts_at: iso(shift.startMs),
				ends_at: iso(shift.endMs),
			})),
		),
		chain_ids: spec.n === 1 ? [encodePublicId("esc", "0199a00e-0000-7000-8000-000000000001")] : [],
		created_at: iso(nowMs - 30 * 86_400_000),
		updated_at: iso(nowMs - 86_400_000),
	})
}

/** Three schedules: one with three layers and overrides, one with a long name, one in a gap. */
export const populatedSchedules = (nowMs: number = ONCALL_NOW): ReadonlyArray<V2OnCallSchedule> =>
	Arr.map(SPECS, (spec) => scheduleOf(spec, nowMs))

export const checkoutSchedule = (nowMs: number = ONCALL_NOW): V2OnCallSchedule => scheduleOf(checkout, nowMs)

/** `GET /{id}/shifts` for the checkout schedule over `[fromMs, toMs)`. */
export const checkoutShifts = (nowMs: number, fromMs: number, toMs: number): V2OnCallShifts => {
	const layers = Arr.map(checkout.segments(fromMs), (segments) => clip(segments, fromMs, toMs))
	const overrides = checkout.overrides(nowMs)
	return decodeShifts({
		object: "oncall_shifts",
		schedule_id: encodePublicId("onc", scheduleUuid(1)),
		from: iso(fromMs),
		to: iso(toMs),
		layers: Arr.map(layers, (segments, layerIndex) =>
			Arr.map(segments, (segment) =>
				wireShift({ ...segment, source: { kind: "layer", layer_index: layerIndex } }),
			),
		),
		final: Arr.map(flatten(layers, clip(overrides, fromMs, toMs), fromMs, toMs), wireShift),
	})
}

/** The checkout schedule's upcoming overrides. */
export const checkoutOverrides = (nowMs: number = ONCALL_NOW): ReadonlyArray<V2OnCallOverride> =>
	Arr.map(checkout.overrides(nowMs), (override) =>
		decodeOverride({
			id: encodePublicId("ovr", override.id),
			object: "oncall_override",
			schedule_id: encodePublicId("onc", scheduleUuid(1)),
			user_id: override.userId,
			starts_at: iso(override.startMs),
			ends_at: iso(override.endMs),
			created_by: m(0),
			created_at: iso(nowMs - 86_400_000),
		}),
	)

const eventUuid = (n: number) => `0199a011-0000-7000-8000-${pad(n)}`

/** `paged` incident events: one sent, one failed, one still on its way. */
export const pagedEvents = (incidentId: string, atMs: number): ReadonlyArray<V2AlertIncidentEvent> =>
	Arr.map(
		[
			{ n: 1, user: 0, channel: "slack", status: "sent", error: null, minutes: 1 },
			{ n: 2, user: 0, channel: "email", status: "sent", error: null, minutes: 1 },
			{
				n: 3,
				user: 1,
				channel: "discord",
				status: "failed",
				error: "Dana has not linked a Discord account",
				minutes: 11,
			},
			{ n: 4, user: 1, channel: "email", status: "sending", error: null, minutes: 11 },
		],
		(event) =>
			decodeEvent({
				id: encodePublicId("evt", eventUuid(event.n)),
				object: "alert_incident_event",
				incident_id: encodePublicId("inc", incidentId),
				type: "paged",
				actor: null,
				source: null,
				page: {
					user_id: memberId(event.user),
					name: NAMES[event.user] ?? null,
					channel: event.channel,
					status: event.status,
					error_message: event.error,
				},
				created_at: iso(atMs + event.minutes * 60_000),
			}),
	)

const decodeChain = Schema.decodeUnknownSync(V2EscalationChain)

/** A chain built through the API: a destination, then a person and a schedule, then a person. */
export const mixedTargetChain = (destinationId: string): V2EscalationChain =>
	decodeChain({
		id: encodePublicId("esc", "0199a00e-0000-7000-8000-000000000001"),
		object: "escalation_chain",
		name: "Checkout on-call",
		description: null,
		steps: [
			{
				targets: [{ type: "destination", destination_id: encodePublicId("dest", destinationId) }],
				wait_minutes: 5,
			},
			{
				targets: [
					{ type: "schedule", schedule_id: schedulePublicId(1) },
					{ type: "user", user_id: memberId(1) },
				],
				wait_minutes: 15,
			},
			{ targets: [{ type: "user", user_id: memberId(0) }], wait_minutes: 30 },
		],
		repeat_count: 1,
		rule_ids: [],
		created_at: iso(ONCALL_NOW),
		updated_at: iso(ONCALL_NOW),
	})
