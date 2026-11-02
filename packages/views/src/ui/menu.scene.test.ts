import * as Animation from "@foldkit/ui/animation"
import { inertHtml as ih } from "foldkit/html"
import {
	Command,
	expect,
	expectOutMessage,
	given,
	keydown,
	Mount,
	role,
	scene,
	withViewInputs,
} from "foldkit/scene"
import { expect as assert, describe, test } from "vitest"
import {
	FocusMenuItem,
	init,
	type ItemRef,
	Message,
	MountMenu,
	MountSubmenu,
	OutMessage,
	update,
	WaitForMenuExit,
	WaitSubmenuDelay,
} from "./menu"
import { type MenuEntry, view } from "./menu-view"

/** Dropdown menu: arrows move the highlight, ArrowRight opens the submenu, ArrowLeft returns. */
const ID = "row-actions"

const ENTRIES: ReadonlyArray<MenuEntry> = [
	{ _tag: "Item", value: "open", label: "Open trace", shortcut: "Enter" },
	{
		_tag: "Submenu",
		value: "dashboards",
		label: "Add to dashboard",
		entries: [
			{ _tag: "Item", value: "checkout", label: "Checkout latency" },
			{ _tag: "Item", value: "payments", label: "Payments" },
		],
	},
	{ _tag: "Separator" },
	{ _tag: "Checkbox", value: "wrap", label: "Wrap lines", isChecked: false },
]

const sceneView = withViewInputs(view, {
	entries: ENTRIES,
	toView: ({ trigger, withTrigger }) => ih.main([], withTrigger(ih.button([...trigger], ["Row actions"]))),
})
const config = { update, view: sceneView() }

const menu = role("menu", { name: "Row actions" })
const submenu = role("menu", { name: "Add to dashboard" })
const item = (name: string) => role("menuitem", { name: new RegExp(`^${name}`) })
const focused = () => Command.resolve(FocusMenuItem, Message.CompletedFocusMenuItem())

const opened = () => [
	given(init(ID, { isOpen: true })),
	Mount.resolve(MountMenu, Message.CompletedMountMenu()),
]

describe("dropdown menu scene", () => {
	test("ArrowRight on the submenu trigger opens the submenu on its first item; ArrowLeft returns", () => {
		scene(
			config,
			...opened(),
			keydown(menu, "ArrowDown"),
			focused(),
			keydown(menu, "ArrowDown"),
			focused(),
			expect(item("Add to dashboard")).toHaveAttr("data-highlighted", ""),
			expect(submenu).toBeAbsent(),
			keydown(menu, "ArrowRight"),
			focused(),
			Mount.resolve(MountSubmenu, Message.CompletedMountSubmenu()),
			expect(item("Add to dashboard")).toHaveAttr("aria-expanded", "true"),
			expect(item("Checkout latency")).toHaveAttr("data-highlighted", ""),
			keydown(submenu, "ArrowDown"),
			focused(),
			expect(item("Payments")).toHaveAttr("data-highlighted", ""),
			keydown(submenu, "ArrowDown"),
			focused(),
			expect(item("Checkout latency")).toHaveAttr("data-highlighted", ""),
			keydown(submenu, "ArrowLeft"),
			focused(),
			Mount.expectEnded(MountSubmenu),
			expect(submenu).toBeAbsent(),
			expect(item("Add to dashboard")).toHaveAttr("data-highlighted", ""),
		)
	})

	test("Enter in the submenu picks its item and closes the whole menu", () => {
		scene(
			config,
			...opened(),
			keydown(menu, "End"),
			focused(),
			keydown(menu, "ArrowUp"),
			focused(),
			keydown(menu, "ArrowRight"),
			focused(),
			Mount.resolve(MountSubmenu, Message.CompletedMountSubmenu()),
			keydown(submenu, "End"),
			focused(),
			keydown(submenu, "Enter"),
			expectOutMessage(OutMessage.SelectedSubmenuItem({ submenu: "dashboards", value: "payments" })),
			Command.resolve(
				Animation.WaitForPaint,
				Animation.Message.CompletedWaitForPaint({ generation: 1 }),
			),
			expect(menu).toHaveAttr("data-closed", ""),
			Mount.expectEnded(MountSubmenu),
			Command.resolve(
				WaitForMenuExit({ id: ID, generation: 1 }),
				Animation.Message.EndedAnimation({ generation: 1 }),
			),
			Mount.expectEnded(MountMenu),
			expect(menu).toBeAbsent(),
		)
	})

	test("a checkbox item reports its toggle and keeps the menu open", () => {
		const highlighted = update(
			init(ID, { isOpen: true }),
			Message.PressedMenuKey({
				key: "End",
				items: [
					{ kind: "Item", value: "open" },
					{ kind: "Submenu", value: "dashboards" },
					{ kind: "Checkbox", value: "wrap" },
				],
			}),
		)
		const toggled = update(
			highlighted.model,
			Message.ClickedItem({ index: 2, item: { kind: "Checkbox", value: "wrap" } }),
		)
		assert({ isOpen: toggled.model.isOpen, outMessage: toggled.outMessage }).toEqual({
			isOpen: true,
			outMessage: OutMessage.ToggledCheckbox({ value: "wrap" }),
		})
	})

	test("hovering the submenu trigger opens the submenu after the delay; a stale delay is dropped", () => {
		const ref: ItemRef = { kind: "Submenu", value: "dashboards" }
		const hovered = update(init(ID, { isOpen: true }), Message.HoveredItem({ index: 1, item: ref }))
		const generation = hovered.model.submenuGeneration
		const away = update(
			hovered.model,
			Message.HoveredItem({ index: 0, item: { kind: "Item", value: "open" } }),
		)
		const stale = update(
			away.model,
			Message.ElapsedSubmenuDelay({ generation, index: 1, value: "dashboards" }),
		)
		const opened = update(
			hovered.model,
			Message.ElapsedSubmenuDelay({ generation, index: 1, value: "dashboards" }),
		)
		assert({
			commands: hovered.commands?.map((command) => command.name),
			stale: stale.model.submenu,
			opened: opened.model.submenu?.value,
		}).toEqual({ commands: ["FocusMenuItem", WaitSubmenuDelay.name], stale: null, opened: "dashboards" })
	})
})
