import * as CalendarDates from "foldkit/calendar"
import type { HtmlBuilder } from "foldkit/html"
import { all, click, Command, expect, expectAll, given, keydown, role, scene } from "foldkit/scene"
import { describe, test } from "vitest"
import { FocusDay, init, Message, type Model, update } from "./calendar"
import { view } from "./calendar-view"

const program = {
	update,
	view: (model: Model, h: HtmlBuilder<Message>) => view(model, {}, h),
}
const october = init({
	month: CalendarDates.make(2026, 10, 1),
	selected: CalendarDates.make(2026, 10, 14),
	today: CalendarDates.make(2026, 10, 17),
})

const day = (name: string | RegExp) => role("button", { name })
const caption = role("status")

describe("calendar", () => {
	test("shows the month around the selected day, which holds the tab stop", () => {
		scene(
			program,
			given(october),
			expect(caption).toHaveText("October 2026"),
			expect(role("grid", { name: "October 2026" })).toExist(),
			expectAll(all.role("gridcell")).toHaveCount(35),
			expect(day("Wednesday, October 14th, 2026, selected")).toHaveAttr("tabindex", "0"),
			expect(day("Today, Saturday, October 17th, 2026")).toHaveAttr("tabindex", "-1"),
			expect(day("Sunday, September 27th, 2026")).toExist(),
		)
	})

	test("clicking a day selects it, clicking it again clears the selection", () => {
		scene(
			program,
			given(october),
			click(day("Tuesday, October 20th, 2026")),
			expect(day("Tuesday, October 20th, 2026, selected")).toHaveAttr("tabindex", "0"),
			expect(day("Wednesday, October 14th, 2026")).toHaveAttr("tabindex", "-1"),
			click(day("Tuesday, October 20th, 2026, selected")),
			expect(day("Tuesday, October 20th, 2026")).toExist(),
			expect(day(/, selected$/)).toBeAbsent(),
		)
	})

	test("the navigation buttons page by month", () => {
		scene(
			program,
			given(october),
			click(day("Go to the Next Month")),
			expect(caption).toHaveText("November 2026"),
			click(day("Go to the Previous Month")),
			click(day("Go to the Previous Month")),
			expect(caption).toHaveText("September 2026"),
		)
	})

	test("arrow keys move the tab stop and focus, PageDown pages to the next month", () => {
		scene(
			program,
			given(october),
			keydown(day("Wednesday, October 14th, 2026, selected"), "ArrowRight"),
			Command.expectExact(FocusDay({ day: "2026-10-15" })),
			Command.resolve(FocusDay, Message.CompletedFocusDay()),
			expect(day("Thursday, October 15th, 2026")).toHaveAttr("tabindex", "0"),
			keydown(day("Thursday, October 15th, 2026"), "PageDown"),
			Command.resolve(FocusDay, Message.CompletedFocusDay()),
			expect(caption).toHaveText("November 2026"),
			expect(day("Sunday, November 15th, 2026")).toHaveAttr("tabindex", "0"),
		)
	})

	test("moving onto an outside day keeps the month; leaving the grid navigates", () => {
		scene(
			program,
			given(october),
			click(day("Thursday, October 1st, 2026")),
			keydown(day("Thursday, October 1st, 2026, selected"), "ArrowLeft"),
			Command.resolve(FocusDay, Message.CompletedFocusDay()),
			expect(caption).toHaveText("October 2026"),
			expect(day("Wednesday, September 30th, 2026")).toHaveAttr("tabindex", "0"),
			keydown(day("Wednesday, September 30th, 2026"), "ArrowUp"),
			Command.resolve(FocusDay, Message.CompletedFocusDay()),
			expect(caption).toHaveText("September 2026"),
			expect(day("Wednesday, September 23rd, 2026")).toHaveAttr("tabindex", "0"),
		)
	})
})
