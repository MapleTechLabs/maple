import { useCallback, useEffect, useState } from "react"
import { useTheme } from "@maple/ui/hooks/use-theme"
import { CommandPalette } from "@/components/command-palette/command-palette"
import { KeyboardShortcutsDialog } from "@/components/command-palette/keyboard-shortcuts-dialog"
import { useAppHotkey } from "@/hooks/use-app-hotkey"

const SHOW_SHORTCUTS_EVENT = "maple:show-keyboard-shortcuts"

/** Open the keyboard-shortcuts help dialog from anywhere (e.g. the sidebar Support menu). */
export function showKeyboardShortcuts() {
	document.dispatchEvent(new CustomEvent(SHOW_SHORTCUTS_EVENT))
}

/**
 * App-wide keyboard UX, mounted once in the root AppFrame:
 * ⌘K command palette, "?" shortcuts help, and "/" focus-search.
 */
export function GlobalShortcuts() {
	const [paletteOpen, setPaletteOpen] = useState(false)
	const [shortcutsOpen, setShortcutsOpen] = useState(false)
	const { theme, setTheme } = useTheme()

	useAppHotkey("palette.open", () => setPaletteOpen((current) => !current))

	useAppHotkey("help.shortcuts", () => setShortcutsOpen(true))

	useAppHotkey("theme.toggle", () => setTheme(theme === "dark" ? "light" : "dark"))

	useAppHotkey("search.focus", () => {
		// Pages opt in by tagging their primary search affordance. Inputs get
		// focused; anything else (e.g. the traces Advanced Filter trigger) is
		// clicked to open its editor.
		const target = document.querySelector<HTMLElement>('[data-shortcut-focus="search"]')
		if (!target) return
		if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
			target.focus()
			target.select()
		} else {
			target.click()
		}
	})

	const handleShowShortcuts = useCallback(() => {
		setPaletteOpen(false)
		setShortcutsOpen(true)
	}, [])

	useEffect(() => {
		const onShow = () => setShortcutsOpen(true)
		document.addEventListener(SHOW_SHORTCUTS_EVENT, onShow)
		return () => document.removeEventListener(SHOW_SHORTCUTS_EVENT, onShow)
	}, [])

	return (
		<>
			<CommandPalette
				open={paletteOpen}
				onOpenChange={setPaletteOpen}
				onShowShortcuts={handleShowShortcuts}
			/>
			<KeyboardShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
		</>
	)
}
