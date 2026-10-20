import { parseWarehouseDateTime, formatWarehouseDateTime, zonedDateParts, zonedPartsToEpochMs } from "@maple/query-engine/datetime"
import { Effect, Option, Schema } from "effect"
import type { Update } from "foldkit"
import * as Calendar from "foldkit/calendar"
import { defineMessageUnion } from "foldkit/message"

// The custom range picker: a two-month range calendar and two time inputs in the selected
// zone's wall clock. The view is
// `custom-range-view.ts`.

export const CalendarDate = Calendar.CalendarDate
export type CalendarDate = Calendar.CalendarDate

export const Model = Schema.Struct({
	timeZone: Schema.String,
	/** The first of the two months shown (starts on today's month). */
	viewYear: Schema.Number,
	viewMonth: Schema.Number,
	/** `dateLib.today()`: the browser's day, which carries the today dot. */
	today: CalendarDate,
	/** `disabled={{ after: today }}`, today judged in the selected zone. */
	lastDay: CalendarDate,
	maybeFrom: Schema.Option(CalendarDate),
	maybeTo: Schema.Option(CalendarDate),
	startInput: Schema.String,
	endInput: Schema.String,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	ClickedPreviousMonth: {},
	ClickedNextMonth: {},
	ClickedDay: { date: CalendarDate },
	ChangedStartTime: { value: Schema.String },
	ChangedEndTime: { value: Schema.String },
	ClickedApply: {},
	ClickedCancel: {},
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
	AppliedRange: { startTime: Schema.String, endTime: Schema.String },
	CancelledRange: {},
})
export type OutMessage = typeof OutMessage.Type

const pad = (value: number) => String(value).padStart(2, "0")

/** The window's ends as the zone's calendar day and `HH:mm` (stored times are UTC warehouse strings). */
const wallClock = (value: string, timeZone: string) => {
	const parts = zonedDateParts(parseWarehouseDateTime(value), timeZone)
	return { day: Calendar.make(parts.year, parts.month, parts.day), clock: `${pad(parts.hour)}:${pad(parts.minute)}` }
}

const validEnd = (value: string | null) =>
	Option.filter(Option.fromNullishOr(value), (raw) => Number.isFinite(parseWarehouseDateTime(raw)))

export interface Seed {
	readonly startTime: string | null
	readonly endTime: string | null
	readonly timeZone: string
	readonly today: CalendarDate
	readonly lastDay: CalendarDate
}

export const init = (seed: Seed): Model => {
	const start = Option.map(validEnd(seed.startTime), (value) => wallClock(value, seed.timeZone))
	const end = Option.map(validEnd(seed.endTime), (value) => wallClock(value, seed.timeZone))
	return {
		timeZone: seed.timeZone,
		viewYear: seed.today.year,
		viewMonth: seed.today.month,
		today: seed.today,
		lastDay: seed.lastDay,
		maybeFrom: Option.map(start, (part) => part.day),
		maybeTo: Option.map(end, (part) => part.day),
		startInput: Option.match(start, { onNone: () => "00:00", onSome: (part) => part.clock }),
		endInput: Option.match(end, { onNone: () => "23:59", onSome: (part) => part.clock }),
	}
}

/** The days the custom tab needs from the clock: the browser's today and the zone's. */
export const readToday = (timeZone: string) =>
	Effect.all({ today: Calendar.today.local, lastDay: Calendar.today.inZone(timeZone) }).pipe(
		Effect.map(({ today, lastDay }) => ({
			today: Calendar.make(today.year, today.month, today.day),
			lastDay: Calendar.make(lastDay.year, lastDay.month, lastDay.day),
		})),
	)

const TIME_INPUT = /^(\d{2}):(\d{2})$/

/** `parseTimeInput`: the `HH:mm` a time input holds, or none. */
export const parseTimeInput = (input: string): Option.Option<{ hours: number; minutes: number }> => {
	const match = TIME_INPUT.exec(input)
	if (match === null) return Option.none()
	const hours = Number(match[1])
	const minutes = Number(match[2])
	return hours < 24 && minutes < 60 ? Option.some({ hours, minutes }) : Option.none()
}

type Range = { maybeFrom: Option.Option<CalendarDate>; maybeTo: Option.Option<CalendarDate> }

/** Adds a day to the range (`addToRange` with `min = 0`, not required). */
export const addToRange = (range: Range, date: CalendarDate): Range => {
	const span = (start: CalendarDate, end: CalendarDate): Range => ({
		maybeFrom: Option.some(start),
		maybeTo: Option.some(end),
	})
	const cleared: Range = { maybeFrom: Option.none(), maybeTo: Option.none() }
	if (Option.isNone(range.maybeFrom)) return Option.isNone(range.maybeTo) ? span(date, date) : cleared
	const start = range.maybeFrom.value
	if (Option.isNone(range.maybeTo)) return Calendar.isBefore(date, start) ? span(date, start) : span(start, date)
	const end = range.maybeTo.value
	if (Calendar.isEqual(start, date) && Calendar.isEqual(end, date)) return cleared
	if (Calendar.isEqual(start, date)) return span(start, date)
	if (Calendar.isEqual(end, date)) return span(date, date)
	return Calendar.isBefore(date, start) ? span(date, end) : span(start, date)
}

/** The applied window: each picked day plus its typed time, turned into an instant through the zone. */
export const appliedRange = (model: Model): Option.Option<{ startTime: string; endTime: string }> =>
	Option.map(
		Option.all({
			from: model.maybeFrom,
			to: model.maybeTo,
			start: parseTimeInput(model.startInput),
			end: parseTimeInput(model.endInput),
		}),
		({ from, to, start, end }) => {
			const instant = (day: CalendarDate, time: { hours: number; minutes: number }) =>
				zonedPartsToEpochMs(
					{ year: day.year, month: day.month, day: day.day, hour: time.hours, minute: time.minutes, second: 0 },
					model.timeZone,
				)
			return {
				startTime: formatWarehouseDateTime(instant(from, start)),
				endTime: formatWarehouseDateTime(instant(to, end)),
			}
		},
	)

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage>

const shownMonth = (model: Model, delta: number): Model => {
	const month = Calendar.addMonths(Calendar.make(model.viewYear, model.viewMonth, 1), delta)
	return { ...model, viewYear: month.year, viewMonth: month.month }
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		ClickedPreviousMonth: () => ({ model: shownMonth(model, -1) }),
		ClickedNextMonth: () => ({ model: shownMonth(model, 1) }),
		ClickedDay: ({ date }) => ({ model: { ...model, ...addToRange(model, date) } }),
		ChangedStartTime: ({ value }) => ({ model: { ...model, startInput: value } }),
		ChangedEndTime: ({ value }) => ({ model: { ...model, endInput: value } }),
		ClickedApply: () =>
			Option.match(appliedRange(model), {
				onNone: () => ({ model }),
				onSome: (range) => ({ model, outMessage: OutMessage.AppliedRange(range) }),
			}),
		ClickedCancel: () => ({ model, outMessage: OutMessage.CancelledRange() }),
	})
