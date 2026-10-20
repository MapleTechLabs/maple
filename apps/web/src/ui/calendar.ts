import { Effect, Option, Schema } from "effect"
import { Command, type Update } from "foldkit"
import * as Calendar from "foldkit/calendar"
import * as Dom from "foldkit/dom"
import { defineMessageUnion } from "foldkit/message"

// Port of packages/ui/src/components/ui/calendar.tsx, single mode: react-day-picker's state as a
// Submodel. The view is `calendar-view.ts`. @foldkit/ui's Calendar is an activedescendant grid
// with a focusable table and ARIA rows that react-day-picker does not render, so the DOM is ours;
// the date math is foldkit/calendar.

export const CalendarDate = Calendar.CalendarDate
export type CalendarDate = Calendar.CalendarDate

// MODEL

export const Model = Schema.Struct({
	viewYear: Schema.Number,
	viewMonth: Schema.Number,
	today: CalendarDate,
	maybeSelected: Schema.Option(CalendarDate),
	/** The day keyboard navigation or a click last moved to; it holds the roving tabindex. */
	maybeFocused: Schema.Option(CalendarDate),
})
export type Model = typeof Model.Type

export interface InitConfig {
	readonly today: CalendarDate
	/** `defaultMonth`: any date in the month shown first. Defaults to the selected day, then today. */
	readonly month?: CalendarDate
	readonly selected?: CalendarDate
}

export const init = (config: InitConfig): Model => {
	const month = config.month ?? config.selected ?? config.today
	return {
		viewYear: month.year,
		viewMonth: month.month,
		today: config.today,
		maybeSelected: Option.fromNullishOr(config.selected),
		maybeFocused: Option.none(),
	}
}

// MESSAGE

export const DayKey = Schema.Literals([
	"ArrowLeft",
	"ArrowRight",
	"ArrowUp",
	"ArrowDown",
	"PageUp",
	"PageDown",
	"Home",
	"End",
])
export type DayKey = typeof DayKey.Type

export const Message = defineMessageUnion({
	ClickedPreviousMonth: {},
	ClickedNextMonth: {},
	ClickedDay: { date: CalendarDate },
	PressedDayKey: { date: CalendarDate, key: DayKey, isShift: Schema.Boolean },
	CompletedFocusDay: {},
})
export type Message = typeof Message.Type

/** The `data-day` value react-day-picker writes on a day cell (`yyyy-MM-dd`). */
export const isoDay = (date: CalendarDate): string =>
	`${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`

// COMMAND

/** Moves DOM focus to a day button after the render that shows it. */
export const FocusDay = Command.define("FocusDay", {
	args: { day: Schema.String },
	messages: [Message.CompletedFocusDay],
	execute: ({ day }) =>
		Dom.focus(`td[data-day="${day}"] > button`).pipe(
			Effect.ignore,
			Effect.as(Message.CompletedFocusDay()),
		),
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message>

const showMonth = (model: Model, date: CalendarDate): Model => ({
	...model,
	viewYear: date.year,
	viewMonth: date.month,
})

/** react-day-picker's `getNextFocus` for one key (no disabled days, no min/max). */
const moveFocus = (date: CalendarDate, key: DayKey, isShift: boolean): CalendarDate => {
	switch (key) {
		case "ArrowLeft":
			return Calendar.addDays(date, -1)
		case "ArrowRight":
			return Calendar.addDays(date, 1)
		case "ArrowUp":
			return Calendar.addDays(date, -7)
		case "ArrowDown":
			return Calendar.addDays(date, 7)
		case "PageUp":
			return isShift ? Calendar.addYears(date, -1) : Calendar.addMonths(date, -1)
		case "PageDown":
			return isShift ? Calendar.addYears(date, 1) : Calendar.addMonths(date, 1)
		case "Home":
			return Calendar.startOfWeek(date, "Sunday")
		case "End":
			return Calendar.endOfWeek(date, "Sunday")
	}
}

const firstOfView = (model: Model): CalendarDate => Calendar.make(model.viewYear, model.viewMonth, 1)

/** The shown weeks, Sunday first, outside days included (`showOutsideDays`, no `fixedWeeks`). */
export const gridWeeks = (model: Model): ReadonlyArray<ReadonlyArray<CalendarDate>> => {
	const first = firstOfView(model)
	const start = Calendar.startOfWeek(first, "Sunday")
	const end = Calendar.endOfWeek(Calendar.lastOfMonth(first), "Sunday")
	const weekCount = (Calendar.daysUntil(start, end) + 1) / 7
	return Array.from({ length: weekCount }, (_, week) =>
		Array.from({ length: 7 }, (_, day) => Calendar.addDays(start, week * 7 + day)),
	)
}

const isInGrid = (model: Model, date: CalendarDate): boolean =>
	gridWeeks(model).some((week) => week.some((day) => Calendar.isEqual(day, date)))

/** react-day-picker's focus target: the focused day, else the selected one, else today, else the 1st. */
export const tabbableDay = (model: Model): CalendarDate => {
	const inView = (date: CalendarDate) => date.year === model.viewYear && date.month === model.viewMonth
	const inGrid = (date: CalendarDate) => isInGrid(model, date)
	return Option.getOrElse(
		Option.orElse(Option.filter(model.maybeFocused, inGrid), () =>
			Option.filter(model.maybeSelected, inView),
		),
		() => (inView(model.today) ? model.today : firstOfView(model)),
	)
}

export const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		ClickedPreviousMonth: () => ({ model: showMonth(model, Calendar.addMonths(firstOfView(model), -1)) }),
		ClickedNextMonth: () => ({ model: showMonth(model, Calendar.addMonths(firstOfView(model), 1)) }),
		// Single mode without `required`: clicking the selected day clears it.
		ClickedDay: ({ date }) => ({
			model: {
				...model,
				maybeFocused: Option.some(date),
				maybeSelected: Option.exists(model.maybeSelected, (selected) =>
					Calendar.isEqual(selected, date),
				)
					? Option.none()
					: Option.some(date),
			},
		}),
		PressedDayKey: ({ date, key, isShift }) => {
			const next = moveFocus(date, key, isShift)
			const moved = { ...model, maybeFocused: Option.some(next) }
			// react-day-picker only navigates when the day is not in the grid (outside days count).
			return {
				model: isInGrid(model, next) ? moved : showMonth(moved, next),
				commands: [FocusDay({ day: isoDay(next) })],
			}
		},
		CompletedFocusDay: () => ({ model }),
	})
