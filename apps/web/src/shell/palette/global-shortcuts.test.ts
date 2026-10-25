import { Option } from "effect"
import { describe, expect, test } from "vitest"
import * as Dialog from "../../ui/dialog"
import { Message } from "../message"
import { init, type Model } from "../model"
import { update } from "../update"
import * as Palette from "./model"
import { displayAlternates, SHORTCUTS } from "./shortcuts"

// `GlobalShortcuts` in the shell: Mod+K, the palette's actions, the shortcuts dialog.

const signedIn = (): Model => ({
	...init({ isMobile: false, theme: "dark", pinnedNamespaces: {}, dashboardFavorites: [] }),
	maybeOrgId: Option.some("org_parity"),
})

const step = (model: Model, message: Message) => update(model, message)
const toPalette = (message: Palette.Message) => Message.GotPaletteMessage({ message })

const commandNames = (result: { commands?: ReadonlyArray<{ name: string }> }) =>
	result.commands?.map((command) => command.name) ?? []

describe("global shortcuts", () => {
	test("Mod+K opens the palette, and pressed again keeps it as it is", () => {
		const opened = step(signedIn(), Message.PressedPaletteShortcut()).model
		expect(opened.palette).not.toBeNull()
		expect(step(opened, Message.PressedPaletteShortcut()).model.palette).toBe(opened.palette)
	})

	test("Escape unmounts the palette and starts the services read's idle TTL", () => {
		const opened = step(signedIn(), Message.ClickedSearch()).model
		const closed = step(
			opened,
			toPalette(Palette.Message.GotDialogMessage({ message: Dialog.Message.PressedEscape() })),
		)
		expect(closed.model.palette).toBeNull()
		expect(commandNames(closed)).toContain("ReleasePaletteServices")
	})

	test("the shortcuts action opens the dialog, and the palette leaves once focus moved there", () => {
		const opened = step(signedIn(), Message.ClickedSearch()).model
		const picked = step(
			opened,
			toPalette(Palette.Message.ClickedEntry({ id: "action:keyboard-shortcuts" })),
		)
		expect(picked.model.shortcutsDialog?.isOpen).toBe(true)
		expect(picked.model.palette?.isClosing).toBe(true)
		expect(step(picked.model, toPalette(Palette.Message.ElapsedCloseDelay())).model.palette).toBeNull()
	})

	test("the theme action flips the theme and closes the palette", () => {
		const opened = step(signedIn(), Message.ClickedSearch()).model
		const picked = step(opened, toPalette(Palette.Message.ClickedEntry({ id: "action:toggle-theme" })))
		expect(picked.model.theme).toBe("light")
		expect(picked.model.palette).toBeNull()
	})

	test("Enter on the highlighted page is the shell's navigation request", () => {
		const opened = step(signedIn(), Message.ClickedSearch()).model
		const entered = step(
			opened,
			toPalette(Palette.Message.PressedEnter({ visibleFlagged: ["/releases", "/security"] })),
		)
		expect(entered.outMessage).toEqual({ _tag: "RequestedNavigation", url: "/" })
	})

	test("the shortcuts dialog spells Mod per platform", () => {
		const palette = SHORTCUTS[0]
		expect(palette === undefined ? [] : displayAlternates(palette, "mac")).toEqual([["⌘", "K"]])
		expect(palette === undefined ? [] : displayAlternates(palette, "windows")).toEqual([["Ctrl", "K"]])
	})
})
