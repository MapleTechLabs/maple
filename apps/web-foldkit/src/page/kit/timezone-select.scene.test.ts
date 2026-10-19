import { click, Command, expect as expectView, given, Mount, role, scene, text, type as typeInto, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import * as Animation from "@foldkit/ui/animation"
import * as Combobox from "../../ui/combobox"
import * as Popover from "../../ui/popover"
import { init, Message, MountUtcOffset, PRESET_VALUES, ReadZoneRows, SelectTimeZone, update, view } from "./time-range-picker"
import { matchesZoneQuery, zoneRows } from "./timezone-zones"

// `TimezoneSelect`: the zone list is read (clock frozen) when it opens; a pick stores the preference.

const SUMMER = Date.parse("2026-07-01T12:00:00Z")
const rows = zoneRows(["Asia/Tokyo", "America/New_York", "Europe/Berlin", "UTC", "Europe/Amsterdam"], "Europe/Berlin", SUMMER)

const opened = () => {
	const model = init("picker")
	return { ...model, popover: Popover.open(model.popover).model }
}

const sceneView = withViewInputs(view, { label: "Last 1 hour", selectedPreset: "1h", presets: PRESET_VALUES })

describe("time zone list", () => {
	test("System and UTC are pinned, then zones west to east and A-Z within an offset", () => {
		expect(rows.map((row) => row.value)).toEqual([
			"__system__",
			"UTC",
			"America/New_York",
			"Europe/Amsterdam",
			"Europe/Berlin",
			"Asia/Tokyo",
		])
		expect(rows.map((row) => row.startsGroup)).toEqual([false, false, true, false, false, false])
	})

	test("a query matches the zone, its offset or the time there now", () => {
		const tokyo = rows[5]!
		expect(tokyo).toMatchObject({ city: "Tokyo", region: "Asia", offset: "UTC+9", clock: "21:00" })
		expect(["tokyo", "utc+9", "21:00", "berlin"].map((query) => matchesZoneQuery(tokyo, query))).toEqual([
			true,
			true,
			true,
			false,
		])
		expect(matchesZoneQuery(rows[0]!, "system")).toBe(true)
	})

	test("the footer opens the list, filters it, and picking a zone stores it", () => {
		scene(
			{ update, view: sceneView() },
			given(opened()),
			Mount.resolve(Popover.MountPopover, Popover.Message.CompletedMountPopover()),
			Mount.resolve(MountUtcOffset, Message.ResolvedUtcOffset({ timeZone: "Europe/Berlin", label: "UTC+2", isSystem: true })),
			expectView(text("System")).toExist(),
			click(role("combobox", { name: "Timezone" })),
			Command.resolve(ReadZoneRows(), Message.ResolvedZoneRows({ rows })),
			Mount.resolve(Combobox.MountCombobox, Combobox.Message.CompletedMountCombobox()),
			Command.resolve(Animation.WaitForPaint, Animation.Message.CompletedWaitForPaint({ generation: 1 })),
			Command.resolve(Animation.WaitForAnimationSettled, Animation.Message.EndedAnimation({ generation: 1 })),
			expectView(text("Tokyo")).toExist(),
			typeInto(role("combobox", { name: "" }), "utc+9"),
			expectView(text("Berlin")).not.toExist(),
			click(role("option", { name: /^Tokyo/ })),
			Command.resolve(
				SelectTimeZone({ value: "Asia/Tokyo" }),
				Message.ResolvedUtcOffset({ timeZone: "Asia/Tokyo", label: "UTC+9", isSystem: false }),
			),
			Command.resolve(Animation.WaitForPaint, Animation.Message.CompletedWaitForPaint({ generation: 2 })),
			Command.resolve(
				Combobox.WaitForComboboxExit({ id: "picker-timezone", generation: 2 }),
				Animation.Message.EndedAnimation({ generation: 2 }),
			),
			Mount.expectEnded(Combobox.MountCombobox),
			expectView(text("Asia/Tokyo")).toExist(),
			expectView(text("System")).not.toExist(),
		)
	})
})
