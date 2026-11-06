import {
	MAX_ONCALL_LAYERS,
	MAX_ONCALL_PARTICIPANTS,
	MAX_ONCALL_RESTRICTIONS,
	OnCallLocalTime,
	OnCallScheduleDescription,
	OnCallScheduleName,
	OnCallTimeZone,
	OnCallWeekday,
	UserId,
} from "@maple/domain/http"
import type {
	V2OnCallLayer,
	V2OnCallRestriction,
	V2OnCallRotation,
	V2OnCallSchedule,
	V2OnCallScheduleCreateParams,
} from "@maple/domain/http/v2"
import { zonedDateParts, zonedPartsToEpochMs } from "@maple/query-engine/datetime"
import { Array as Arr, Option, Schema, String as Str } from "effect"
import { isoMs, msIso } from "../shared/time"

// The schedule form's draft: name, zone and up to five layers, each with its rotation and
// restrictions, held as typed text and checked against the API's own schemas.

export const RotationKind = Schema.Literals(["daily", "weekly", "custom"])
export type RotationKind = typeof RotationKind.Type

export const RestrictionDraft = Schema.Struct({
	key: Schema.String,
	weekdays: Schema.Array(OnCallWeekday),
	startTime: Schema.String,
	endTime: Schema.String,
})
export type RestrictionDraft = typeof RestrictionDraft.Type

export const LayerDraft = Schema.Struct({
	key: Schema.String,
	name: Schema.String,
	/** In rotation order. */
	participants: Schema.Array(UserId),
	rotation: RotationKind,
	handoffWeekday: OnCallWeekday,
	handoffTime: Schema.String,
	lengthHours: Schema.String,
	/** `YYYY-MM-DDTHH:MM` on the schedule zone's wall clock (a `datetime-local` value). */
	startsAt: Schema.String,
	/** The saved start, sent back exactly (seconds, a repeated DST hour) until its text is edited. */
	startsAtMs: Schema.NullOr(Schema.Number),
	restrictions: Schema.Array(RestrictionDraft),
})
export type LayerDraft = typeof LayerDraft.Type

export const Form = Schema.Struct({
	name: Schema.String,
	description: Schema.String,
	timeZone: Schema.String,
	layers: Schema.Array(LayerDraft),
	/** The next key a layer or restriction takes, so rows keep identity across reorders. */
	nextKey: Schema.Number,
})
export type Form = typeof Form.Type

export const WEEKDAYS: ReadonlyArray<Readonly<{ value: OnCallWeekday; label: string }>> = [
	{ value: "mon", label: "Mon" },
	{ value: "tue", label: "Tue" },
	{ value: "wed", label: "Wed" },
	{ value: "thu", label: "Thu" },
	{ value: "fri", label: "Fri" },
	{ value: "sat", label: "Sat" },
	{ value: "sun", label: "Sun" },
]

const pad = (n: number) => Str.padStart(2, "0")(String(n))

/** `ms` as a `datetime-local` value on `timeZone`'s wall clock. */
export const localInputOf = (ms: number, timeZone: string): string => {
	const parts = zonedDateParts(ms, timeZone)
	return `${Str.padStart(4, "0")(String(parts.year))}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`
}

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u

/** A `datetime-local` value read on `timeZone`'s wall clock, as epoch ms. */
export const localInputMs = (value: string, timeZone: string): Option.Option<number> => {
	const match = LOCAL_INPUT.exec(value)
	if (match === null || !isZone(timeZone)) return Option.none()
	const [, year, month, day, hour, minute] = Arr.map(match, Number)
	const ms = zonedPartsToEpochMs(
		{
			year: year ?? 0,
			month: month ?? 1,
			day: day ?? 1,
			hour: hour ?? 0,
			minute: minute ?? 0,
			second: 0,
		},
		timeZone,
	)
	return Number.isFinite(ms) ? Option.some(ms) : Option.none()
}

/** Today at 09:00 in the zone: where a new layer's rotation starts. */
const defaultStart = (nowMs: number, timeZone: string): string =>
	`${Str.slice(0, 10)(localInputOf(nowMs, isZone(timeZone) ? timeZone : "UTC"))}T09:00`

export const emptyLayer = (key: number, index: number, nowMs: number, timeZone: string): LayerDraft => ({
	key: `l${key}`,
	name: index === 0 ? "Primary" : `Layer ${index + 1}`,
	participants: [],
	rotation: "weekly",
	handoffWeekday: "mon",
	handoffTime: "09:00",
	lengthHours: "12",
	startsAt: defaultStart(nowMs, timeZone),
	startsAtMs: null,
	restrictions: [],
})

export const emptyRestriction = (key: number): RestrictionDraft => ({
	key: `r${key}`,
	weekdays: ["mon", "tue", "wed", "thu", "fri"],
	startTime: "18:00",
	endTime: "08:00",
})

export const emptyForm = (timeZone: string, nowMs: number): Form => ({
	name: "",
	description: "",
	timeZone,
	layers: [emptyLayer(0, 0, nowMs, timeZone)],
	nextKey: 1,
})

/** The form filled from a saved schedule; its starts read on the schedule's own zone. */
export const formFromSchedule = (schedule: V2OnCallSchedule): Form => {
	const layers = Arr.map(schedule.layers, (layer, layerIndex): LayerDraft => {
		const rotation = layer.rotation
		return {
			key: `l${layerIndex}`,
			name: layer.name,
			participants: layer.participants,
			rotation: rotation.kind,
			handoffWeekday: rotation.kind === "weekly" ? rotation.handoff_weekday : "mon",
			handoffTime: rotation.kind === "custom" ? "09:00" : rotation.handoff_time,
			lengthHours: rotation.kind === "custom" ? String(rotation.length_hours) : "12",
			startsAt: localInputOf(isoMs(layer.starts_at), schedule.time_zone),
			startsAtMs: isoMs(layer.starts_at),
			restrictions: Arr.map(layer.restrictions ?? [], (restriction, index) => ({
				key: `r${layerIndex}x${index}`,
				weekdays: restriction.weekdays,
				startTime: restriction.start_time,
				endTime: restriction.end_time,
			})),
		}
	})
	return {
		name: schedule.name,
		description: schedule.description ?? "",
		timeZone: schedule.time_zone,
		layers,
		nextKey: layers.length,
	}
}

// VALIDATION: the limits the API's schemas hold, as one message per field.

const isName = Schema.is(OnCallScheduleName)
const isDescription = Schema.is(OnCallScheduleDescription)
const isZone = Schema.is(OnCallTimeZone)
const isLocalTime = Schema.is(OnCallLocalTime)
const isShiftLength = (raw: string) => {
	const hours = Number(Str.trim(raw))
	return Str.trim(raw) !== "" && Number.isInteger(hours) && hours >= 1 && hours <= 336
}

export const nameError = (name: string): Option.Option<string> =>
	Str.isEmpty(Str.trim(name))
		? Option.some("Name the schedule")
		: isName(Str.trim(name))
			? Option.none()
			: Option.some("Keep the name to 120 characters")

export const descriptionError = (description: string): Option.Option<string> =>
	isDescription(Str.trim(description))
		? Option.none()
		: Option.some("Keep the description to 500 characters")

export const zoneError = (zone: string): Option.Option<string> =>
	isZone(zone) ? Option.none() : Option.some("Pick a time zone from the list")

/** One layer's field errors, by field. */
export type LayerErrors = Readonly<{
	name: Option.Option<string>
	participants: Option.Option<string>
	handoff: Option.Option<string>
	startsAt: Option.Option<string>
	restrictions: ReadonlyArray<Option.Option<string>>
}>

const restrictionError = (restriction: RestrictionDraft): Option.Option<string> =>
	restriction.weekdays.length === 0
		? Option.some("Pick at least one day")
		: !isLocalTime(restriction.startTime) || !isLocalTime(restriction.endTime)
			? Option.some("Use HH:MM times")
			: Option.none()

/** The layer's start: the saved instant while untouched, else its text on the zone's clock. */
const layerStartMs = (layer: LayerDraft, timeZone: string): Option.Option<number> =>
	layer.startsAtMs === null ? localInputMs(layer.startsAt, timeZone) : Option.some(layer.startsAtMs)

export const layerErrors = (layer: LayerDraft, timeZone: string): LayerErrors => {
	const name = Str.trim(layer.name)
	return {
		name:
			name === ""
				? Option.some("Name the layer")
				: name.length > 100
					? Option.some("Keep the layer name to 100 characters")
					: Option.none(),
		participants:
			layer.participants.length === 0
				? Option.some("Add at least one person")
				: layer.participants.length > MAX_ONCALL_PARTICIPANTS
					? Option.some(`A layer rotates at most ${MAX_ONCALL_PARTICIPANTS} people`)
					: Option.none(),
		handoff:
			layer.rotation === "custom"
				? isShiftLength(layer.lengthHours)
					? Option.none()
					: Option.some("Shifts last 1 to 336 whole hours")
				: isLocalTime(layer.handoffTime)
					? Option.none()
					: Option.some("Use an HH:MM handoff time"),
		startsAt: Option.isSome(layerStartMs(layer, timeZone))
			? Option.none()
			: Option.some("Pick when the rotation starts"),
		restrictions: Arr.map(layer.restrictions, restrictionError),
	}
}

const hasLayerError = (errors: LayerErrors) =>
	Option.isSome(errors.name) ||
	Option.isSome(errors.participants) ||
	Option.isSome(errors.handoff) ||
	Option.isSome(errors.startsAt) ||
	Arr.some(errors.restrictions, Option.isSome)

/** What still blocks saving, one short phrase each, for the action bar. */
export const formIssues = (form: Form): ReadonlyArray<string> => [
	...(Option.isSome(nameError(form.name)) ? ["Name"] : []),
	...(Option.isSome(descriptionError(form.description)) ? ["Description"] : []),
	...(Option.isSome(zoneError(form.timeZone)) ? ["Time zone"] : []),
	...(form.layers.length === 0 ? ["At least one layer"] : []),
	...Arr.flatMap(form.layers, (layer, index) =>
		hasLayerError(layerErrors(layer, form.timeZone)) ? [`Layer ${index + 1}`] : [],
	),
]

const rotationOf = (layer: LayerDraft): V2OnCallRotation =>
	layer.rotation === "daily"
		? { kind: "daily", handoff_time: layer.handoffTime }
		: layer.rotation === "weekly"
			? { kind: "weekly", handoff_weekday: layer.handoffWeekday, handoff_time: layer.handoffTime }
			: { kind: "custom", length_hours: Number(Str.trim(layer.lengthHours)) }

const restrictionOf = (restriction: RestrictionDraft): Option.Option<V2OnCallRestriction> =>
	Arr.isReadonlyArrayNonEmpty(restriction.weekdays)
		? Option.some({
				weekdays: restriction.weekdays,
				start_time: restriction.startTime,
				end_time: restriction.endTime,
			})
		: Option.none()

const layerOf = (layer: LayerDraft, timeZone: string): Option.Option<V2OnCallLayer> =>
	Option.flatMap(layerStartMs(layer, timeZone), (startMs) => {
		const participants = layer.participants
		return Arr.isReadonlyArrayNonEmpty(participants)
			? Option.map(
					Option.all(Arr.map(layer.restrictions, restrictionOf)),
					(restrictions): V2OnCallLayer => ({
						name: Str.trim(layer.name),
						participants,
						rotation: rotationOf(layer),
						starts_at: msIso(startMs),
						...(restrictions.length === 0 ? undefined : { restrictions }),
					}),
				)
			: Option.none()
	})

/** The create payload the form describes, or none while anything blocks saving. */
export const payloadOf = (form: Form): Option.Option<V2OnCallScheduleCreateParams> =>
	formIssues(form).length > 0 || form.layers.length > MAX_ONCALL_LAYERS
		? Option.none()
		: Option.flatMap(
				Option.all(Arr.map(form.layers, (layer) => layerOf(layer, form.timeZone))),
				(layers) =>
					Arr.isReadonlyArrayNonEmpty(layers)
						? Option.some({
								name: Str.trim(form.name),
								description: Str.isEmpty(Str.trim(form.description))
									? null
									: Str.trim(form.description),
								time_zone: form.timeZone,
								layers,
							})
						: Option.none(),
			)

export { MAX_ONCALL_LAYERS, MAX_ONCALL_RESTRICTIONS }
