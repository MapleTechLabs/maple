import { expect as expectView, given, Mount, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import * as Popover from "../../ui/popover"
import { formatUtcOffset, init, Message, MountUtcOffset, PRESET_VALUES, update, view } from "./time-range-picker"

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
			Mount.resolve(MountUtcOffset, Message.ResolvedUtcOffset({ timeZone: "Europe/Berlin", label: "UTC+2" })),
			expectView(text("UTC+2")).toExist(),
		)
	})
})
