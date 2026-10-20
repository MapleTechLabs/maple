import * as Animation from "@foldkit/ui/animation"
import {
	Command,
	contextMenu,
	expect,
	expectOutMessage,
	given,
	keydown,
	Mount,
	role,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { expect as assert, describe, test } from "vitest"
import {
	FocusMenuItem,
	init,
	itemId,
	Message,
	MountContextMenu,
	OutMessage,
	update,
	WaitForContextMenuExit,
} from "./context-menu"
import { view } from "./context-menu-view"

/** Context menu: a right-click opens it; arrows move the highlight; Enter picks; Escape closes. */
const ID = "span-menu"

const sceneView = withViewInputs(view, {
	entries: [
		{ _tag: "Item", label: "Filter by service", shortcut: "F" },
		{ _tag: "Item", label: "Exclude service" },
		{ _tag: "Separator" },
		{ _tag: "Item", label: "Hide span", variant: "destructive" },
	],
	triggerContent: ["Right-click a span"],
})
const config = { update, view: sceneView() }

const menu = role("menu")
const item = (name: string) => role("menuitem", { name: new RegExp(`^${name}`) })

/** A navigation key; the highlight's focus move is a Command, resolved here. */
const navigate = (key: string) => [
	keydown(menu, key),
	Command.resolve(FocusMenuItem, Message.CompletedFocusMenuItem()),
]

const opened = () => [
	contextMenu(text("Right-click a span")),
	Mount.resolve(MountContextMenu, Message.CompletedMountContextMenu()),
	Command.resolve(Animation.WaitForPaint, Animation.Message.CompletedWaitForPaint({ generation: 1 })),
	Command.resolve(Animation.WaitForAnimationSettled, Animation.Message.EndedAnimation({ generation: 1 })),
]

const exited = () => [
	Command.resolve(Animation.WaitForPaint, Animation.Message.CompletedWaitForPaint({ generation: 2 })),
	Command.resolve(
		WaitForContextMenuExit({ id: ID, generation: 2 }),
		Animation.Message.EndedAnimation({ generation: 2 }),
	),
	Mount.expectEnded(MountContextMenu),
	expect(menu).toBeAbsent(),
]

describe("context menu scene", () => {
	test("a right-click opens the menu at the pointer, on the right, with nothing highlighted", () => {
		scene(
			config,
			given(init(ID)),
			expect(menu).toBeAbsent(),
			...opened(),
			expect(menu).toHaveAttr("data-side", "right"),
			expect(menu).toHaveAttr("data-align", "start"),
			expect(item("Filter by service")).not.toHaveAttr("data-highlighted"),
			expect(item("Hide span")).toHaveAttr("data-variant", "destructive"),
		)
	})

	test("arrows skip the separator and wrap; Enter picks the highlighted item and closes", () => {
		scene(
			config,
			given(init(ID)),
			...opened(),
			...navigate("ArrowDown"),
			expect(item("Filter by service")).toHaveAttr("data-highlighted", ""),
			...navigate("ArrowDown"),
			...navigate("ArrowDown"),
			expect(item("Hide span")).toHaveAttr("data-highlighted", ""),
			...navigate("ArrowDown"),
			expect(item("Filter by service")).toHaveAttr("data-highlighted", ""),
			...navigate("End"),
			keydown(menu, "Enter"),
			expectOutMessage(OutMessage.SelectedItem({ index: 3 })),
			...exited(),
		)
	})

	test("hovering an item highlights it and moves focus to it", () => {
		const hovered = update(init(ID, { isOpen: true }), Message.HoveredItem({ index: 1 }))
		assert(hovered.commands?.map((command) => command.name)).toEqual(["FocusMenuItem"])
		scene(
			config,
			given(hovered.model),
			Mount.resolve(MountContextMenu, Message.CompletedMountContextMenu()),
			expect(item("Exclude service")).toHaveAttr("data-highlighted", ""),
			expect(item("Exclude service")).toHaveAttr("id", itemId(ID, 1)),
		)
	})

	test("Escape closes the menu", () => {
		scene(
			config,
			given(init(ID)),
			...opened(),
			keydown(menu, "Escape"),
			expect(menu).toHaveAttr("data-closed", ""),
			...exited(),
		)
	})

	test("a press outside closes the menu", () => {
		scene(
			config,
			given(init(ID, { isOpen: true })),
			Mount.resolve(MountContextMenu, Message.PressedOutside()),
			Command.resolve(
				Animation.WaitForPaint,
				Animation.Message.CompletedWaitForPaint({ generation: 1 }),
			),
			Command.resolve(
				WaitForContextMenuExit({ id: ID, generation: 1 }),
				Animation.Message.EndedAnimation({ generation: 1 }),
			),
			Mount.expectEnded(MountContextMenu),
			expect(menu).toBeAbsent(),
		)
	})
})
