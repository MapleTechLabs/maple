import {
	AlertMaintenanceWindowId,
	AlertMaintenanceWindowName,
	AlertMaintenanceWindowReason,
	AlertRuleId,
	MAX_ALERT_SILENCE_DURATION_MS,
	MaintenanceDurationMinutes,
	MaintenanceStartTime,
	MaintenanceTimeZone,
	MaintenanceWeekday,
} from "@maple/domain/http"
import {
	V2AlertMaintenanceWindow,
	V2AlertMaintenanceWindowCreateParams,
	type V2MaintenanceSchedule,
} from "@maple/domain/http/v2"
import { Effect, Option, Order, Result, Schema, Array as Arr, String as Str } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Combobox from "@maple/views/ui/combobox"
import * as Dialog from "@maple/views/ui/dialog"
import * as Menu from "@maple/views/ui/menu"
import type { Resources } from "../../../platform/resources"
import { browserZone, readSupportedTimeZones } from "../../../platform/time-zone"
import {
	emptyTypedMatchers,
	hasMatchers,
	MatcherField,
	matchersFromTyped,
	TypedMatchers,
	typedFromMatchers,
} from "../shared/matcher-fields"
import { saveMaintenanceWindow, WEEKDAYS } from "../shared/maintenance-windows"
import { isoMs, msIso } from "../shared/time"
import { localInputOf } from "../schedule-form/form"
import { parseLocalDateTime } from "../silence-dialog/dialog"

// "New maintenance window" / "Edit maintenance window": the hub's dialog, as one Submodel.

export const ScheduleKind = Schema.Literals(["once", "weekly"])
export type ScheduleKind = typeof ScheduleKind.Type

export const Model = Schema.Struct({
	dialog: Dialog.Model,
	editingId: Schema.NullOr(AlertMaintenanceWindowId),
	name: Schema.String,
	reason: Schema.String,
	typed: TypedMatchers,
	/** Rules the window names; picked from the rules the hub has synced. */
	ruleIds: Schema.Array(AlertRuleId),
	ruleMenu: Menu.Model,
	kind: ScheduleKind,
	/** A one-off window's start and end, as `datetime-local` values in `timeZone`. */
	startsAt: Schema.String,
	endsAt: Schema.String,
	days: Schema.Array(MaintenanceWeekday),
	/** `HH:MM`, read in `timeZone`. */
	startTime: Schema.String,
	durationMinutes: Schema.String,
	timeZone: Schema.String,
	/** Every IANA zone the browser knows, for the zone picker. */
	zones: Schema.Array(Schema.String),
	zonePicker: Combobox.Model,
	excludeFromBaselines: Schema.Boolean,
	enabled: Schema.Boolean,
	/** The wall clock when the dialog opened: a one-off end is checked against it. */
	nowMs: Schema.Number,
	isSaving: Schema.Boolean,
	/** A save was tried: every field shows what is wrong with it. */
	isShowingErrors: Schema.Boolean,
	saveError: Schema.NullOr(Schema.String),
	/** Bumped on every open: a save's result only settles the form it was sent from. */
	openCount: Schema.Number,
})
export type Model = typeof Model.Type

export const DEFAULT_START_TIME = "02:00"
export const DEFAULT_DURATION_MINUTES = "120"

export const ruleMenuIdOf = (id: string): string => `${id}-rules`
export const zonePickerIdOf = (id: string): string => `${id}-zone`

export const init = (id: string): Model => ({
	dialog: Dialog.init(id, "dialog"),
	editingId: null,
	name: "",
	reason: "",
	typed: { services: "", tags: "", environments: "" },
	ruleIds: [],
	ruleMenu: Menu.init(ruleMenuIdOf(id)),
	kind: "weekly",
	startsAt: "",
	endsAt: "",
	days: [],
	startTime: DEFAULT_START_TIME,
	durationMinutes: DEFAULT_DURATION_MINUTES,
	timeZone: "UTC",
	zones: [],
	zonePicker: Combobox.init(zonePickerIdOf(id), "single", { selected: ["UTC"] }),
	excludeFromBaselines: true,
	enabled: true,
	nowMs: 0,
	isSaving: false,
	isShowingErrors: false,
	saveError: null,
	openCount: 0,
})

/** The picker's zones: the browser's list, plus `UTC` (which it leaves out) and the form's own zone. */
export const zoneItems = (model: Pick<Model, "zones" | "timeZone">): ReadonlyArray<string> =>
	Arr.sort(Arr.dedupe(Arr.filter([...model.zones, "UTC", model.timeZone], Str.isNonEmpty)), Order.String)

// VALIDATION: the limits the API's schemas hold.

const isName = Schema.is(AlertMaintenanceWindowName)
const isReason = Schema.is(AlertMaintenanceWindowReason)
const isStartTime = Schema.is(MaintenanceStartTime)
const isDuration = Schema.is(MaintenanceDurationMinutes)
const isZone = Schema.is(MaintenanceTimeZone)

export const nameError = (name: string): Option.Option<string> =>
	Str.isEmpty(Str.trim(name))
		? Option.some("Name the window")
		: isName(Str.trim(name))
			? Option.none()
			: Option.some("Keep the name to 120 characters")

export const reasonError = (reason: string): Option.Option<string> =>
	Str.isEmpty(Str.trim(reason)) || isReason(Str.trim(reason))
		? Option.none()
		: Option.some("Keep the reason to 400 characters")

export const matchersOf = (model: Pick<Model, "typed" | "ruleIds">) => ({
	...matchersFromTyped(model.typed),
	...(model.ruleIds.length === 0 ? undefined : { rule_ids: model.ruleIds }),
})

export const matchersError = (model: Pick<Model, "typed" | "ruleIds">): Option.Option<string> =>
	hasMatchers(matchersOf(model)) ? Option.none() : Option.some("Pick a rule or fill in at least one field")

export const zoneError = (zone: string): Option.Option<string> =>
	isZone(zone) ? Option.none() : Option.some("Pick a time zone from the list")

export const startsAtError = (model: Pick<Model, "startsAt" | "timeZone">): Option.Option<string> =>
	Option.isSome(parseLocalDateTime(model.startsAt, model.timeZone))
		? Option.none()
		: Option.some("Pick a start date and time")

/** A new window must end ahead of now; an edit may rename one that already ran. */
export const endsAtError = (
	model: Pick<Model, "startsAt" | "endsAt" | "timeZone" | "nowMs" | "editingId">,
): Option.Option<string> =>
	Option.match(parseLocalDateTime(model.endsAt, model.timeZone), {
		onNone: () => Option.some("Pick an end date and time"),
		onSome: (endMs) =>
			Option.match(parseLocalDateTime(model.startsAt, model.timeZone), {
				onNone: () => Option.none(),
				onSome: (startMs) =>
					endMs <= startMs
						? Option.some("End the window after it starts")
						: endMs - startMs > MAX_ALERT_SILENCE_DURATION_MS
							? Option.some("A one-off window can last at most 30 days")
							: model.editingId === null && endMs <= model.nowMs
								? Option.some("Pick an end in the future")
								: Option.none(),
			}),
	})

export const daysError = (days: ReadonlyArray<MaintenanceWeekday>): Option.Option<string> =>
	days.length === 0 ? Option.some("Pick at least one day") : Option.none()

export const startTimeError = (startTime: string): Option.Option<string> =>
	isStartTime(startTime) ? Option.none() : Option.some("Enter a time as HH:MM")

/** The duration as a whole number of minutes; none when it is not one. */
export const durationOf = (raw: string): Option.Option<number> => {
	const trimmed = Str.trim(raw)
	return /^\d+$/.test(trimmed) ? Option.some(Number(trimmed)) : Option.none()
}

export const durationError = (raw: string): Option.Option<string> =>
	Option.exists(durationOf(raw), isDuration)
		? Option.none()
		: Option.some("Enter 5 to 10080 minutes (7 days)")

/** Every field's error, in form order, for the checks the schedule kind applies. */
export const formErrors = (model: Model): ReadonlyArray<string> =>
	Arr.getSomes([
		nameError(model.name),
		matchersError(model),
		...(model.kind === "once"
			? [startsAtError(model), endsAtError(model)]
			: [daysError(model.days), startTimeError(model.startTime), durationError(model.durationMinutes)]),
		zoneError(model.timeZone),
		reasonError(model.reason),
	])

const scheduleOf = (model: Model): Option.Option<V2MaintenanceSchedule> =>
	model.kind === "once"
		? Option.zipWith(
				parseLocalDateTime(model.startsAt, model.timeZone),
				parseLocalDateTime(model.endsAt, model.timeZone),
				(startMs, endMs): V2MaintenanceSchedule => ({
					type: "once",
					starts_at: msIso(startMs),
					ends_at: msIso(endMs),
				}),
			)
		: Option.map(durationOf(model.durationMinutes), (duration): V2MaintenanceSchedule => ({
				type: "weekly",
				time_zone: model.timeZone,
				days: Arr.map(
					Arr.filter(WEEKDAYS, (day) => model.days.includes(day.value)),
					(day) => day.value,
				),
				start_time: model.startTime,
				duration_minutes: duration,
			}))

/** What the form saves, or none while any field is invalid. */
export const payloadOf = (model: Model): Option.Option<V2AlertMaintenanceWindowCreateParams> =>
	formErrors(model).length > 0
		? Option.none()
		: Option.map(scheduleOf(model), (schedule) => ({
				name: Str.trim(model.name),
				reason: Str.isEmpty(Str.trim(model.reason)) ? null : Str.trim(model.reason),
				matchers: matchersOf(model),
				schedule,
				exclude_from_baselines: model.excludeFromBaselines,
				enabled: model.enabled,
			}))

// MESSAGES

export const Message = defineMessageUnion({
	GotDialogMessage: { message: Dialog.Message },
	ReadZones: { browserZone: Schema.String, zones: Schema.Array(Schema.String) },
	ChangedName: { value: Schema.String },
	ChangedReason: { value: Schema.String },
	ChangedMatcher: { field: MatcherField, value: Schema.String },
	GotRuleMenuMessage: { message: Menu.Message },
	ClickedRemoveRule: { ruleId: AlertRuleId },
	ChangedKind: { kind: ScheduleKind },
	ChangedStartsAt: { value: Schema.String },
	ChangedEndsAt: { value: Schema.String },
	ToggledDay: { day: MaintenanceWeekday },
	ChangedStartTime: { value: Schema.String },
	ChangedDuration: { value: Schema.String },
	GotZoneMessage: { message: Combobox.Message },
	ToggledExcludeFromBaselines: {},
	ToggledEnabled: {},
	ClickedSave: {},
	CompletedSave: {
		openCount: Schema.Number,
		result: Schema.Result(V2AlertMaintenanceWindow, LoadFailure),
	},
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
	SavedWindow: { window: V2AlertMaintenanceWindow, isNew: Schema.Boolean },
})
export type OutMessage = typeof OutMessage.Type

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>

// COMMANDS

/** The browser's zone (a new window's default) and every zone to pick from. */
export const ReadWindowZones = Command.define("ReadMaintenanceWindowZones", {
	messages: [Message.ReadZones],
	execute: Effect.map(Effect.all([browserZone, readSupportedTimeZones]), ([zone, zones]) =>
		Message.ReadZones({ browserZone: zone, zones }),
	),
})

export const SaveWindow = Command.define("SaveMaintenanceWindow", {
	args: {
		openCount: Schema.Number,
		editingId: Schema.NullOr(AlertMaintenanceWindowId),
		payload: V2AlertMaintenanceWindowCreateParams,
	},
	messages: [Message.CompletedSave],
	execute: ({ openCount, editingId, payload }) =>
		saveMaintenanceWindow(editingId, payload).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedSave({ openCount, result })),
		),
})

// UPDATE

const liftDialog = (model: Model, result: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, dialog: result.model },
	commands: Command.mapMessages(result.commands ?? [], (message) => Message.GotDialogMessage({ message })),
})

type Fields = Omit<
	Model,
	| "dialog"
	| "ruleMenu"
	| "zones"
	| "zonePicker"
	| "nowMs"
	| "isSaving"
	| "isShowingErrors"
	| "saveError"
	| "openCount"
>

const open = (model: Model, fields: Fields, nowMs: number): Return => {
	const opened = liftDialog(
		{
			...model,
			...fields,
			nowMs,
			ruleMenu: Menu.init(ruleMenuIdOf(model.dialog.id)),
			zonePicker: Combobox.init(zonePickerIdOf(model.dialog.id), "single", {
				selected: [fields.timeZone],
			}),
			isSaving: false,
			isShowingErrors: false,
			saveError: null,
			openCount: model.openCount + 1,
		},
		Dialog.open(model.dialog),
	)
	return { ...opened, commands: [...(opened.commands ?? []), ReadWindowZones()] }
}

const HOUR_MS = 60 * 60_000

/** A new window: weekly at 02:00 for two hours, or once from the next full hour, in `timeZone`. */
export const openNew = (model: Model, nowMs: number, timeZone: string): Return => {
	const nextHourMs = Math.ceil((nowMs + 1) / HOUR_MS) * HOUR_MS
	return open(
		model,
		{
			editingId: null,
			name: "",
			reason: "",
			typed: emptyTypedMatchers,
			ruleIds: [],
			kind: "weekly",
			startsAt: localInputOf(nextHourMs, timeZone),
			endsAt: localInputOf(nextHourMs + 2 * HOUR_MS, timeZone),
			days: [],
			startTime: DEFAULT_START_TIME,
			durationMinutes: DEFAULT_DURATION_MINUTES,
			timeZone,
			excludeFromBaselines: true,
			enabled: true,
		},
		nowMs,
	)
}

/** A saved window; a one-off one reads in the viewer's zone, a weekly one in its own. */
export const openEdit = (
	model: Model,
	window: V2AlertMaintenanceWindow,
	nowMs: number,
	timeZone: string,
): Return => {
	const schedule = window.schedule
	const zone = schedule.type === "weekly" ? schedule.time_zone : timeZone
	return open(
		model,
		{
			editingId: window.id,
			name: window.name,
			reason: window.reason ?? "",
			typed: typedFromMatchers(window.matchers),
			ruleIds: window.matchers.rule_ids ?? [],
			kind: schedule.type,
			startsAt: schedule.type === "once" ? localInputOf(isoMs(schedule.starts_at), zone) : "",
			endsAt: schedule.type === "once" ? localInputOf(isoMs(schedule.ends_at), zone) : "",
			days: schedule.type === "weekly" ? schedule.days : [],
			startTime: schedule.type === "weekly" ? schedule.start_time : DEFAULT_START_TIME,
			durationMinutes:
				schedule.type === "weekly" ? String(schedule.duration_minutes) : DEFAULT_DURATION_MINUTES,
			timeZone: zone,
			excludeFromBaselines: window.exclude_from_baselines,
			enabled: window.enabled,
		},
		nowMs,
	)
}

/** A form edit is dropped while a save is in flight: the saved window is what the dialog shows. */
const unlessSaving = (model: Model, edit: () => Model): Return =>
	model.isSaving ? { model } : { model: edit() }

const ruleMenuStep = (model: Model, message: Menu.Message): Return => {
	const result = Menu.update(model.ruleMenu, message)
	const commands = Command.mapMessages(result.commands ?? [], (child) =>
		Message.GotRuleMenuMessage({ message: child }),
	)
	const picked = Option.flatMap(
		result.outMessage?._tag === "SelectedItem" ? Option.some(result.outMessage.value) : Option.none(),
		Schema.decodeUnknownOption(AlertRuleId),
	)
	const next: Model = { ...model, ruleMenu: result.model }
	return Option.match(model.isSaving ? Option.none() : picked, {
		onNone: () => ({ model: next, commands }),
		onSome: (ruleId) => ({
			model: next.ruleIds.includes(ruleId) ? next : { ...next, ruleIds: [...next.ruleIds, ruleId] },
			commands,
		}),
	})
}

/** A zone picked from the list; anything typed that is not a zone leaves the form's zone alone. */
const zoneStep = (model: Model, message: Combobox.Message): Return => {
	const step = Combobox.update(model.zonePicker, message)
	const commands = Command.mapMessages(step.commands ?? [], (child) =>
		Message.GotZoneMessage({ message: child }),
	)
	const zone =
		step.outMessage?._tag === "ChangedValue" && zoneItems(model).includes(step.outMessage.value)
			? step.outMessage.value
			: null
	return {
		model: {
			...model,
			zonePicker: step.model,
			timeZone: zone === null || model.isSaving ? model.timeZone : zone,
		},
		commands,
	}
}

const save = (model: Model): Return =>
	model.isSaving
		? { model }
		: Option.match(payloadOf(model), {
				onNone: () => ({ model: { ...model, isShowingErrors: true } }),
				onSome: (payload) => ({
					model: { ...model, isSaving: true, isShowingErrors: true, saveError: null },
					commands: [
						SaveWindow({ openCount: model.openCount, editingId: model.editingId, payload }),
					],
				}),
			})

const toggled = <A>(values: ReadonlyArray<A>, value: A): ReadonlyArray<A> =>
	values.includes(value) ? Arr.filter(values, (existing) => existing !== value) : [...values, value]

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotDialogMessage: ({ message: child }) =>
			// The dialog stays open while a save is in flight.
			model.isSaving ? { model } : liftDialog(model, Dialog.update(model.dialog, child)),
		ReadZones: ({ browserZone: zone, zones }) => {
			// A new window starts on the browser's zone; an edit keeps its own.
			const timeZone = model.editingId === null && !model.isSaving ? zone : model.timeZone
			return {
				model: {
					...model,
					zones,
					timeZone,
					zonePicker:
						timeZone === model.timeZone
							? model.zonePicker
							: Combobox.init(model.zonePicker.id, "single", { selected: [timeZone] }),
				},
			}
		},
		ChangedName: ({ value }) => unlessSaving(model, () => ({ ...model, name: value })),
		ChangedReason: ({ value }) => unlessSaving(model, () => ({ ...model, reason: value })),
		ChangedMatcher: ({ field, value }) =>
			unlessSaving(model, () => ({ ...model, typed: { ...model.typed, [field]: value } })),
		GotRuleMenuMessage: ({ message: child }) => ruleMenuStep(model, child),
		ClickedRemoveRule: ({ ruleId }) =>
			unlessSaving(model, () => ({
				...model,
				ruleIds: Arr.filter(model.ruleIds, (id) => id !== ruleId),
			})),
		ChangedKind: ({ kind }) => unlessSaving(model, () => ({ ...model, kind })),
		ChangedStartsAt: ({ value }) => unlessSaving(model, () => ({ ...model, startsAt: value })),
		ChangedEndsAt: ({ value }) => unlessSaving(model, () => ({ ...model, endsAt: value })),
		ToggledDay: ({ day }) => unlessSaving(model, () => ({ ...model, days: toggled(model.days, day) })),
		ChangedStartTime: ({ value }) => unlessSaving(model, () => ({ ...model, startTime: value })),
		ChangedDuration: ({ value }) => unlessSaving(model, () => ({ ...model, durationMinutes: value })),
		GotZoneMessage: ({ message: child }) => zoneStep(model, child),
		ToggledExcludeFromBaselines: () =>
			unlessSaving(model, () => ({ ...model, excludeFromBaselines: !model.excludeFromBaselines })),
		ToggledEnabled: () => unlessSaving(model, () => ({ ...model, enabled: !model.enabled })),
		ClickedSave: () => save(model),
		CompletedSave: ({ openCount, result }) =>
			openCount !== model.openCount
				? { model }
				: Result.match(result, {
						onSuccess: (window) => ({
							...liftDialog({ ...model, isSaving: false }, Dialog.close(model.dialog)),
							outMessage: OutMessage.SavedWindow({ window, isNew: model.editingId === null }),
						}),
						onFailure: (failure) => ({
							model: { ...model, isSaving: false, saveError: failure.message },
						}),
					}),
	})
