import { cn } from "@maple/ui/lib/utils"
import { calendarChevronStyles, calendarClassNames, calendarStyles } from "@maple/ui/styles/ui/calendar"
import { fieldLabelStyles, fieldStyles } from "@maple/ui/styles/ui/field"
import { Option } from "effect"
import * as Calendar from "foldkit/calendar"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineView } from "foldkit/submodel"
import { button } from "../../ui/button"
import { icon } from "../../ui/icon"
import { input } from "../../ui/input"
import { appliedRange, type CalendarDate, Message, type Model } from "./custom-range"

// The custom range picker's DOM: a two-month range calendar (en-US, rdp-* classes, Maple's
// `calendarClassNames`), then the Start/End time fields and the actions.

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const MONTH_NAMES = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
]

const ordinal = (day: number): string =>
	day % 100 >= 11 && day % 100 <= 13 ? `${day}th` : `${day}${["th", "st", "nd", "rd"][day % 10] ?? "th"}`

/** `labelDayButton`: date-fns `PPPP`, "Today, " and ", selected" by modifier. */
const dayLabel = (date: CalendarDate, isToday: boolean, isSelected: boolean): string =>
	`${isToday ? "Today, " : ""}${Calendar.dayOfWeek(date)}, ${MONTH_NAMES[date.month - 1] ?? ""} ${ordinal(date.day)}, ${date.year}${isSelected ? ", selected" : ""}`

/** One month's weeks, Sunday first, outside days included. */
const monthWeeks = (first: CalendarDate): ReadonlyArray<ReadonlyArray<CalendarDate>> => {
	const start = Calendar.startOfWeek(first, "Sunday")
	const end = Calendar.endOfWeek(Calendar.lastOfMonth(first), "Sunday")
	const weekCount = (Calendar.daysUntil(start, end) + 1) / 7
	return Array.from({ length: weekCount }, (_, week) =>
		Array.from({ length: 7 }, (_, day) => Calendar.addDays(start, week * 7 + day)),
	)
}

interface DayFlags {
	readonly isDisabled: boolean
	readonly isOutside: boolean
	readonly isToday: boolean
	readonly isSelected: boolean
	readonly isRangeStart: boolean
	readonly isRangeEnd: boolean
	readonly isRangeMiddle: boolean
	readonly isTabbable: boolean
}

const flagsOf = (model: Model, month: CalendarDate, date: CalendarDate, tabbable: CalendarDate): DayFlags => {
	const from = Option.getOrNull(model.maybeFrom)
	const to = Option.getOrNull(model.maybeTo)
	const isComplete = from !== null && to !== null
	const isSelected =
		from !== null &&
		(to === null
			? Calendar.isEqual(date, from)
			: Calendar.isAfterOrEqual(date, from) && Calendar.isBeforeOrEqual(date, to))
	return {
		isDisabled: Calendar.isAfter(date, model.lastDay),
		isOutside: date.month !== month.month || date.year !== month.year,
		isToday: Calendar.isEqual(date, model.today),
		isSelected,
		isRangeStart: isComplete && Calendar.isEqual(date, from),
		isRangeEnd: isComplete && Calendar.isEqual(date, to),
		isRangeMiddle: isComplete && Calendar.isAfter(date, from) && Calendar.isBefore(date, to),
		isTabbable: Calendar.isEqual(date, tabbable),
	}
}

/** The day class joined with each active modifier's class, in modifier order. */
const dayCellClass = (flags: DayFlags): string =>
	[
		calendarClassNames.day,
		...(flags.isDisabled ? ["rdp-disabled"] : []),
		...(flags.isOutside ? [calendarClassNames.outside] : []),
		...(flags.isToday ? [calendarClassNames.today] : []),
		...(flags.isSelected ? ["rdp-selected"] : []),
		...(flags.isRangeStart ? [calendarClassNames.range_start] : []),
		...(flags.isRangeEnd ? [calendarClassNames.range_end] : []),
		...(flags.isRangeMiddle ? [calendarClassNames.range_middle] : []),
	].join(" ")

const isoOf = (date: CalendarDate): string =>
	`${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`

const dayCell = (h: HtmlBuilder<Message>, date: CalendarDate, flags: DayFlags): Html =>
	h.td(
		[
			h.Role("gridcell"),
			...(flags.isSelected ? [h.AriaSelected(true)] : []),
			h.Attribute("class", dayCellClass(flags)),
			h.DataAttribute("day", isoOf(date)),
			...(flags.isOutside
				? [h.DataAttribute("month", isoOf(date).slice(0, 7)), h.DataAttribute("outside", "true")]
				: []),
			...(flags.isSelected ? [h.DataAttribute("selected", "true")] : []),
			...(flags.isDisabled ? [h.DataAttribute("disabled", "true")] : []),
			...(flags.isToday ? [h.DataAttribute("today", "true")] : []),
		],
		[
			h.button(
				[
					h.AriaLabel(dayLabel(date, flags.isToday, flags.isSelected)),
					h.Attribute("class", calendarClassNames.day_button),
					h.Attribute("tabindex", flags.isTabbable ? "0" : "-1"),
					h.Type("button"),
					...(flags.isDisabled ? [h.Disabled(true)] : [h.OnClick(Message.ClickedDay({ date }))]),
				],
				[String(date.day)],
			),
		],
	)

const navButton = (h: HtmlBuilder<Message>, direction: "Previous" | "Next"): Html =>
	h.button(
		[
			h.AriaLabel(`Go to the ${direction} Month`),
			h.Class(
				direction === "Previous"
					? calendarClassNames.button_previous
					: calendarClassNames.button_next,
			),
			h.Type("button"),
			h.OnClick(direction === "Previous" ? Message.ClickedPreviousMonth() : Message.ClickedNextMonth()),
		],
		[
			icon(h, direction === "Previous" ? "ChevronLeftIcon" : "ChevronRightIcon", {
				className: cn("rdp-chevron", calendarChevronStyles),
			}),
		],
	)

const monthGrid = (
	h: HtmlBuilder<Message>,
	model: Model,
	first: CalendarDate,
	tabbable: CalendarDate,
): Html => {
	const caption = `${MONTH_NAMES[first.month - 1] ?? ""} ${first.year}`
	return h.div(
		[h.Class(calendarClassNames.month)],
		[
			h.div(
				[h.Class(calendarClassNames.month_caption)],
				[
					h.span(
						[h.AriaLive("polite"), h.Class(calendarClassNames.caption_label), h.Role("status")],
						[caption],
					),
				],
			),
			h.table(
				[
					h.AriaLabel(caption),
					h.AriaMultiSelectable(true),
					h.Class("rdp-month_grid"),
					h.Role("grid"),
				],
				[
					h.thead(
						[h.AriaHidden(true)],
						[
							h.tr(
								[h.Class("rdp-weekdays")],
								DAY_NAMES.map((name) =>
									h.th(
										[
											h.AriaLabel(name),
											h.Attribute("class", calendarClassNames.weekday),
											h.Scope("col"),
										],
										[name.slice(0, 2)],
									),
								),
							),
						],
					),
					h.tbody(
						[h.Class("rdp-weeks")],
						monthWeeks(first).map((week) =>
							h.tr(
								[h.Class("rdp-week")],
								week.map((date) => dayCell(h, date, flagsOf(model, first, date, tabbable))),
							),
						),
					),
				],
			),
		],
	)
}

/** The focus target: the start day when shown and enabled, else today, else the 1st. */
const tabbableOf = (model: Model, first: CalendarDate): CalendarDate => {
	const last = Calendar.lastOfMonth(Calendar.addMonths(first, 1))
	const isShown = (date: CalendarDate) =>
		Calendar.isAfterOrEqual(date, first) &&
		Calendar.isBeforeOrEqual(date, last) &&
		!Calendar.isAfter(date, model.lastDay)
	return Option.getOrElse(
		Option.orElse(Option.filter(model.maybeFrom, isShown), () =>
			Option.filter(Option.some(model.today), isShown),
		),
		() => first,
	)
}

const timeField = (
	h: HtmlBuilder<Message>,
	id: string,
	label: string,
	value: string,
	toMessage: (value: string) => Message,
): Html =>
	h.div(
		[
			h.DataAttribute("slot", "field"),
			h.Class(cn(fieldStyles, "flex-1 items-stretch gap-1")),
			h.DataAttribute("filled", ""),
		],
		[
			h.label(
				[
					h.Id(`${id}-label`),
					h.For(id),
					h.DataAttribute("slot", "field-label"),
					h.Class(cn(fieldLabelStyles, "font-normal text-xs text-muted-foreground sm:text-xs")),
					h.DataAttribute("filled", ""),
				],
				[label],
			),
			input(h, {
				id,
				type: "time",
				className: "font-mono",
				fieldState: {
					isInvalid: false,
					isDirty: false,
					isFilled: value !== "",
					isFocused: false,
					isTouched: false,
				},
				attributes: [h.Value(value), h.OnInput(toMessage), h.AriaLabelledBy(`${id}-label`)],
			}),
		],
	)

export const view = defineView<Model, Message, Record<string, never>>((model, _inputs, h) => {
	const first = Calendar.make(model.viewYear, model.viewMonth, 1)
	const tabbable = tabbableOf(model, first)
	const isValidRange = Option.isSome(appliedRange(model))
	return h.div(
		[h.Class("flex flex-col gap-4")],
		[
			h.div(
				[h.Class("flex gap-4")],
				[
					h.div(
						[
							h.Class(`rdp-root ${cn(calendarStyles)}`),
							h.DataAttribute("mode", "range"),
							h.DataAttribute("multiple-months", "true"),
							h.DataAttribute("slot", "calendar"),
							h.Lang("en-US"),
						],
						[
							h.div(
								[h.Class(calendarClassNames.months)],
								[
									h.nav(
										[h.AriaLabel("Navigation bar"), h.Class(calendarClassNames.nav)],
										[navButton(h, "Previous"), navButton(h, "Next")],
									),
									monthGrid(h, model, first, tabbable),
									monthGrid(h, model, Calendar.addMonths(first, 1), tabbable),
								],
							),
						],
					),
				],
			),
			h.div(
				[h.Class("flex gap-4 items-end")],
				[
					timeField(h, "custom-range-start", "Start time", model.startInput, (value) =>
						Message.ChangedStartTime({ value }),
					),
					timeField(h, "custom-range-end", "End time", model.endInput, (value) =>
						Message.ChangedEndTime({ value }),
					),
				],
			),
			h.div(
				[h.Class("flex justify-end gap-2")],
				[
					button(
						h,
						{ variant: "ghost", size: "sm", attributes: [h.OnClick(Message.ClickedCancel())] },
						["Cancel"],
					),
					button(
						h,
						{
							size: "sm",
							isDisabled: !isValidRange,
							attributes: [h.OnClick(Message.ClickedApply())],
						},
						["Apply"],
					),
				],
			),
		],
	)
})
