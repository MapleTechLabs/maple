import * as Animation from "@foldkit/ui/animation"
import { inertHtml as ih } from "foldkit/html"
import {
	click,
	Command,
	expect,
	expectOutMessage,
	given,
	keydown,
	Mount,
	role,
	selector,
	scene,
	withViewInputs,
} from "foldkit/scene"
import { describe, test } from "vitest"
import { FocusSelectItem, init, Message, MountSelect, OutMessage, update, WaitForSelectExit } from "./select"
import { type SelectEntry, view } from "./select-view"

/** Select: opens over the trigger on the selected item; arrows, Enter and Escape drive the list. */
const ID = "env"

const ENTRIES: ReadonlyArray<SelectEntry> = [
	{
		_tag: "Group",
		label: "Deployed",
		items: [
			{ value: "production", label: "Production" },
			{ value: "staging", label: "Staging" },
		],
	},
	{ _tag: "Separator" },
	{ _tag: "Item", item: { value: "development", label: "Development" } },
]

const sceneView = withViewInputs(view, {
	entries: ENTRIES,
	ariaLabel: "Environment",
	toView: (parts) => ih.main([], parts),
})
const config = { update, view: sceneView() }

const trigger = role("combobox", { name: "Environment" })
const listbox = role("listbox")
/** The popup holds the list keys: focus sits on an option, or on the popup when none is highlighted. */
const popup = selector('[data-slot="select-popup"]')
const option = (name: string) => role("option", { name })

const opened = () => [
	Mount.resolve(MountSelect, Message.CompletedMountSelect()),
	Command.resolve(Animation.WaitForPaint, Animation.Message.CompletedWaitForPaint({ generation: 1 })),
	Command.resolve(Animation.WaitForAnimationSettled, Animation.Message.EndedAnimation({ generation: 1 })),
]

const exited = (generation: number) => [
	Command.resolve(Animation.WaitForPaint, Animation.Message.CompletedWaitForPaint({ generation })),
	Command.resolve(
		WaitForSelectExit({ id: ID, generation }),
		Animation.Message.EndedAnimation({ generation }),
	),
	Mount.expectEnded(MountSelect),
	expect(listbox).toBeAbsent(),
]

const navigate = (key: string) => [
	keydown(popup, key),
	Command.resolve(FocusSelectItem, Message.CompletedFocusSelectItem()),
]

describe("select scene", () => {
	test("a click opens the list with the value selected and nothing highlighted until hovered", () => {
		scene(
			config,
			given(init(ID, { value: "staging", selectedIndex: 1 })),
			expect(trigger).toHaveText("Staging"),
			click(trigger),
			...opened(),
			expect(trigger).toHaveAttr("aria-expanded", "true"),
			expect(option("Staging")).toHaveAttr("aria-selected", "true"),
			expect(option("Staging")).not.toHaveAttr("data-highlighted"),
		)
	})

	test("ArrowDown on the trigger opens the list with the selected option highlighted", () => {
		scene(
			config,
			given(init(ID, { value: "staging", selectedIndex: 1 })),
			keydown(trigger, "ArrowDown"),
			...opened(),
			expect(listbox).toExist(),
			expect(option("Staging")).toHaveAttr("data-highlighted", ""),
		)
	})

	test("arrows move the highlight across groups and wrap; Enter selects it and closes", () => {
		scene(
			config,
			given(init(ID, { value: "staging", selectedIndex: 1, isOpen: true })),
			Mount.resolve(MountSelect, Message.CompletedMountSelect()),
			...navigate("ArrowDown"),
			expect(option("Development")).toHaveAttr("data-highlighted", ""),
			...navigate("ArrowDown"),
			expect(option("Production")).toHaveAttr("data-highlighted", ""),
			keydown(popup, "Enter"),
			expectOutMessage(OutMessage.ChangedValue({ value: "production" })),
			...exited(1),
			expect(trigger).toHaveText("Production"),
		)
	})

	test("a click on an option selects it; Escape and an outside press close without selecting", () => {
		scene(
			config,
			given(init(ID, { value: "staging", selectedIndex: 1, isOpen: true })),
			Mount.resolve(MountSelect, Message.CompletedMountSelect()),
			click(option("Development")),
			expectOutMessage(OutMessage.ChangedValue({ value: "development" })),
			...exited(1),
		)
		scene(
			config,
			given(init(ID, { value: "staging", selectedIndex: 1, isOpen: true })),
			Mount.resolve(MountSelect, Message.CompletedMountSelect()),
			keydown(popup, "Escape"),
			...exited(1),
			expect(trigger).toHaveText("Staging"),
		)
		scene(
			config,
			given(init(ID, { value: "staging", selectedIndex: 1, isOpen: true })),
			Mount.resolve(MountSelect, Message.PressedOutside()),
			...exited(1),
		)
	})
})
