import { cn } from "@maple/ui/lib/utils"
import { calendarChevronStyles, calendarClassNames, calendarStyles } from "@maple/ui/styles/ui/calendar"
import { Option, Schema } from "effect"
import * as Calendar from "foldkit/calendar"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineView } from "foldkit/submodel"
import { type CalendarDate, DayKey, gridWeeks, isoDay, Message, type Model, tabbableDay } from "./calendar"
import { icon } from "./icon"

// react-day-picker's DOM for `<Calendar mode="single">` (en-US): rdp-* classes, Maple's
// `calendarClassNames`, the same ARIA labels. Day cells set one `class` attribute (S4).

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

const ordinal = (day: number): string => {
	if (day % 100 >= 11 && day % 100 <= 13) return `${day}th`
	return `${day}${["th", "st", "nd", "rd"][day % 10] ?? "th"}`
}

const monthName = (date: CalendarDate): string => MONTH_NAMES[date.month - 1] ?? ""

/** date-fns `PPPP` ("Wednesday, October 14th, 2026"), the `labelDayButton` base. */
const longDate = (date: CalendarDate): string => {
	return `${Calendar.dayOfWeek(date)}, ${monthName(date)} ${ordinal(date.day)}, ${date.year}`
}

const dayLabel = (date: CalendarDate, isToday: boolean, isSelected: boolean): string =>
	`${isToday ? "Today, " : ""}${longDate(date)}${isSelected ? ", selected" : ""}`

export interface CalendarViewInputs {
	readonly className?: string
}

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

const toDayKey = (date: CalendarDate) => (key: string, modifiers: { readonly shiftKey: boolean }) =>
	Option.map(Option.liftPredicate(key, Schema.is(DayKey)), (dayKey) =>
		Message.PressedDayKey({ date, key: dayKey, isShift: modifiers.shiftKey }),
	)

interface DayFlags {
	readonly isOutside: boolean
	readonly isToday: boolean
	readonly isSelected: boolean
	readonly isTabbable: boolean
}

/** react-day-picker joins the day class with each active modifier's class, in modifier order. */
const dayCellClass = (flags: DayFlags): string =>
	[
		calendarClassNames.day,
		...(flags.isOutside ? [calendarClassNames.outside] : []),
		...(flags.isToday ? [calendarClassNames.today] : []),
		...(flags.isSelected ? ["rdp-selected"] : []),
	].join(" ")

const dayCell = (h: HtmlBuilder<Message>, date: CalendarDate, flags: DayFlags): Html =>
	h.td(
		[
			...(flags.isSelected ? [h.AriaSelected(true)] : []),
			h.Attribute("class", dayCellClass(flags)),
			h.DataAttribute("day", isoDay(date)),
			...(flags.isOutside
				? [h.DataAttribute("month", isoDay(date).slice(0, 7)), h.DataAttribute("outside", "true")]
				: []),
			...(flags.isSelected ? [h.DataAttribute("selected", "true")] : []),
			...(flags.isToday ? [h.DataAttribute("today", "true")] : []),
			h.Role("gridcell"),
		],
		[
			h.button(
				[
					h.AriaLabel(dayLabel(date, flags.isToday, flags.isSelected)),
					h.Attribute("class", calendarClassNames.day_button),
					h.Attribute("tabindex", flags.isTabbable ? "0" : "-1"),
					h.Type("button"),
					h.OnClick(Message.ClickedDay({ date })),
					h.OnKeyDownPreventDefault(toDayKey(date)),
				],
				[String(date.day)],
			),
		],
	)

const weekdayHeader = (h: HtmlBuilder<Message>, name: string): Html =>
	h.th(
		[h.AriaLabel(name), h.Attribute("class", calendarClassNames.weekday), h.Scope("col")],
		[name.slice(0, 2)],
	)

export const view = defineView<Model, Message, CalendarViewInputs>((model, inputs, h) => {
	const caption = `${MONTH_NAMES[model.viewMonth - 1] ?? ""} ${model.viewYear}`
	const tabbable = tabbableDay(model)
	const flagsOf = (date: CalendarDate): DayFlags => ({
		isOutside: date.month !== model.viewMonth || date.year !== model.viewYear,
		isToday: Calendar.isEqual(date, model.today),
		isSelected: Option.exists(model.maybeSelected, (selected) => Calendar.isEqual(selected, date)),
		isTabbable: Calendar.isEqual(date, tabbable),
	})
	return h.div(
		[
			h.Class(`rdp-root ${cn(calendarStyles, inputs.className)}`),
			h.DataAttribute("mode", "single"),
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
					h.div(
						[h.Class(calendarClassNames.month)],
						[
							h.div(
								[h.Class(calendarClassNames.month_caption)],
								[
									h.span(
										[
											h.AriaLive("polite"),
											h.Class(calendarClassNames.caption_label),
											h.Role("status"),
										],
										[caption],
									),
								],
							),
							h.table(
								[
									h.AriaLabel(caption),
									h.AriaMultiSelectable(false),
									h.Class("rdp-month_grid"),
									h.Role("grid"),
								],
								[
									h.thead(
										[h.AriaHidden(true)],
										[
											h.tr(
												[h.Class("rdp-weekdays")],
												DAY_NAMES.map((name) => weekdayHeader(h, name)),
											),
										],
									),
									h.tbody(
										[h.Class("rdp-weeks")],
										gridWeeks(model).map((week) =>
											h.tr(
												[h.Class("rdp-week")],
												week.map((date) => dayCell(h, date, flagsOf(date))),
											),
										),
									),
								],
							),
						],
					),
				],
			),
		],
	)
})
