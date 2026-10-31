import * as Calendar from "foldkit/calendar"
import {
	click,
	Command,
	expect as expectView,
	expectOutMessage,
	given,
	label,
	Mount,
	role,
	scene,
	text,
	type as typeInto,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import * as Popover from "../../ui/popover"
import * as CustomRange from "./custom-range"
import {
	formatUtcOffset,
	init,
	isOpenKey,
	LONG_RANGE_PRESET_VALUES,
	Message,
	MountUtcOffset,
	OutMessage,
	PRESET_VALUES,
	rejectedToast,
	ResolveCustomToday,
	update,
	view,
} from "./time-range-picker"

// The footer's UTC offset is read for the current instant when the picker opens, never in view.

const SUMMER = Date.parse("2026-07-01T12:00:00Z")
const WINTER = Date.parse("2026-01-15T12:00:00Z")

const opened = () => {
	const model = init("picker")
	return { ...model, popover: Popover.open(model.popover).model }
}

const sceneView = withViewInputs(view, {
	label: "Last 1 hour",
	selectedPreset: "1h",
	presets: PRESET_VALUES,
	timeZone: "Europe/Berlin",
})

describe("time range picker offset", () => {
	test("the offset is the zone's at the given instant, and an unknown zone reads UTC", () => {
		expect(formatUtcOffset("Europe/Berlin", SUMMER)).toBe("UTC+2")
		expect(formatUtcOffset("Europe/Berlin", WINTER)).toBe("UTC+1")
		expect(formatUtcOffset("Asia/Kolkata", WINTER)).toBe("UTC+5:30")
		expect(formatUtcOffset("Not/AZone", SUMMER)).toBe("UTC")
	})

	test("the open footer shows the offset its Mount read", () => {
		scene(
			{ update, view: sceneView() },
			given(opened()),
			Mount.resolve(Popover.MountPopover, Popover.Message.CompletedMountPopover()),
			Mount.resolve(
				MountUtcOffset,
				Message.ResolvedUtcOffset({ timeZone: "Europe/Berlin", label: "UTC+2" }),
			),
			expectView(text("UTC+2")).toExist(),
		)
	})
})

const TWO_WEEKS_MAX = 14 * 24 * 60 * 60 + 60 * 60

describe("time range picker maximum range", () => {
	test("a preset or typed range past the page's maximum is refused and the popover stays open", () => {
		const refused = update(
			opened(),
			Message.ClickedPreset({ value: "6w", maxRangeSeconds: TWO_WEEKS_MAX }),
		)
		expect(refused.outMessage).toEqual(OutMessage.RejectedRange({ maxRangeSeconds: TWO_WEEKS_MAX }))
		expect(refused.model.popover.isOpen).toBe(true)
		expect(
			update(opened(), Message.ClickedPreset({ value: "2w", maxRangeSeconds: TWO_WEEKS_MAX }))
				.outMessage,
		).toEqual(OutMessage.SelectedPreset({ presetValue: "2w" }))
		const typed = update(
			{ ...opened(), shorthand: "2mo" },
			Message.PressedShorthandEnter({ maxRangeSeconds: TWO_WEEKS_MAX }),
		)
		expect(typed.outMessage).toEqual(OutMessage.RejectedRange({ maxRangeSeconds: TWO_WEEKS_MAX }))
		expect(typed.model.shorthand).toBe("")
	})

	test("the refusal toast names the maximum in days", () => {
		expect(rejectedToast(TWO_WEEKS_MAX)).toMatchObject({
			type: "error",
			title: "This page supports a maximum range of 14 days",
		})
	})
})

const SEED = { startTime: "2026-10-14 08:00:00", endTime: "2026-10-15 09:30:00", timeZone: "Europe/Berlin" }
const TODAY = Calendar.make(2026, 10, 19)
const customButton = role("button", { name: "Custom range…" })

/** The open picker, then "Custom range…" once the clock gave today (2026-10-19). */
const openCustom = () => [
	Mount.resolve(Popover.MountPopover, Popover.Message.CompletedMountPopover()),
	Mount.resolve(MountUtcOffset, Message.ResolvedUtcOffset({ timeZone: "Europe/Berlin", label: "UTC+2" })),
	click(customButton),
	Command.resolve(
		ResolveCustomToday(SEED),
		Message.ResolvedCustomToday({ ...SEED, today: TODAY, lastDay: TODAY }),
	),
	Mount.expectEnded(MountUtcOffset),
]

describe("time range picker custom range", () => {
	const customView = (presets: ReadonlyArray<string>) =>
		withViewInputs(view, {
			label: "Last 1 hour",
			selectedPreset: "1h",
			presets,
			timeZone: "Europe/Berlin",
			startTime: SEED.startTime,
			endTime: SEED.endTime,
		})()

	test("it opens on the shown window in the zone's wall clock, with no day after today", () => {
		scene(
			{ update, view: customView(PRESET_VALUES) },
			given(opened()),
			...openCustom(),
			expectView(role("button", { name: "Wednesday, October 14th, 2026, selected" })).toExist(),
			expectView(label("Start time")).toHaveValue("10:00"),
			expectView(role("button", { name: "Tuesday, October 20th, 2026" })).toBeDisabled(),
			click(role("button", { name: "Friday, October 16th, 2026" })),
			typeInto(label("End time"), "18:45"),
			expectView(role("button", { name: "Friday, October 16th, 2026, selected" })).toExist(),
			expectView(label("End time")).toHaveValue("18:45"),
		)
	})

	test("Apply picks the absolute window through the zone and closes the picker", () => {
		const seeded = update(
			opened(),
			Message.ResolvedCustomToday({ ...SEED, today: TODAY, lastDay: TODAY }),
		).model
		const custom = (model: typeof seeded, message: CustomRange.Message) =>
			update(model, Message.GotCustomRangeMessage({ message })).model
		const edited = custom(
			custom(seeded, CustomRange.Message.ClickedDay({ date: Calendar.make(2026, 10, 16) })),
			CustomRange.Message.ChangedEndTime({ value: "18:45" }),
		)
		const applied = update(
			edited,
			Message.GotCustomRangeMessage({ message: CustomRange.Message.ClickedApply() }),
		)
		expect(applied.outMessage).toEqual(
			OutMessage.SelectedCustomRange({
				startTime: "2026-10-14 08:00:00",
				endTime: "2026-10-16 16:45:00",
			}),
		)
		expect(applied.model.popover.isOpen).toBe(false)
		expect(applied.model.tab).toBe("relative")
	})

	test("Cancel returns to the presets without picking", () => {
		scene(
			{ update, view: customView(PRESET_VALUES) },
			given(opened()),
			...openCustom(),
			click(role("button", { name: "Cancel" })),
			Mount.resolve(
				MountUtcOffset,
				Message.ResolvedUtcOffset({ timeZone: "Europe/Berlin", label: "UTC+2" }),
			),
			expectView(customButton).toExist(),
			expectView(role("button", { name: "Apply" })).toBeAbsent(),
		)
	})

	test("a long-range page refuses a custom window past a year", () => {
		scene(
			{ update, view: customView(LONG_RANGE_PRESET_VALUES) },
			given(opened()),
			...openCustom(),
			click(role("button", { name: "Go to the Previous Month" })),
			...Array.from({ length: 13 }, () => click(role("button", { name: "Go to the Previous Month" }))),
			click(role("button", { name: "Saturday, August 2nd, 2025" })),
			click(role("button", { name: "Apply" })),
			expectOutMessage(OutMessage.RejectedRange({ maxRangeSeconds: 365 * 24 * 60 * 60 })),
		)
	})
})

describe("time range picker hotkey", () => {
	const press = (key: string, modifiers: Partial<{ shiftKey: boolean; metaKey: boolean }> = {}) => ({
		key,
		metaKey: false,
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		...modifiers,
	})

	test('a bare "D" opens the picker; a modified one does not', () => {
		expect(isOpenKey(press("d"))).toBe(true)
		expect(isOpenKey(press("D"))).toBe(true)
		expect(isOpenKey(press("d", { metaKey: true }))).toBe(false)
		expect(isOpenKey(press("D", { shiftKey: true }))).toBe(false)
		expect(isOpenKey(press("f"))).toBe(false)
	})

	test("the key-less keydown Chrome fires on autofill opens nothing", () => {
		expect(isOpenKey({ ...press("d"), key: undefined })).toBe(false)
	})
})
