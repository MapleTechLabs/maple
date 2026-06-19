import { normalizeRegisterableHotkey } from "@tanstack/react-hotkeys"
import { describe, expect, it } from "vitest"

import {
	allShortcutIds,
	comboDisplayTokens,
	SHORTCUT_GROUPS,
	type ShortcutId,
	shortcutDef,
	shortcutDisplayAlternates,
} from "./shortcuts"

describe("SHORTCUTS registry", () => {
	it("has no duplicate combos across entries (including aliases)", () => {
		const seen = new Map<string, string>()
		for (const id of allShortcutIds()) {
			const def = shortcutDef(id)
			for (const combo of [def.combo, ...(def.aliases ?? [])]) {
				const normalized = normalizeRegisterableHotkey(combo, "mac")
				const existing = seen.get(normalized)
				expect(
					existing,
					`combo ${normalized} registered by both ${existing} and ${id}`,
				).toBeUndefined()
				seen.set(normalized, id)
			}
		}
	})

	it("only uses known groups", () => {
		const groups: ReadonlyArray<string> = SHORTCUT_GROUPS
		for (const id of allShortcutIds()) {
			expect(groups).toContain(shortcutDef(id).group)
		}
	})

	it("every group has at least one shortcut", () => {
		const used = new Set(allShortcutIds().map((id) => shortcutDef(id).group))
		for (const group of SHORTCUT_GROUPS) {
			expect(used).toContain(group)
		}
	})
})

describe("comboDisplayTokens", () => {
	it("renders Mod combos with platform symbols on mac", () => {
		expect(comboDisplayTokens("Mod+K", "mac")).toEqual(["⌘", "K"])
		expect(comboDisplayTokens("Mod+Shift+O", "mac")).toEqual(["⇧", "⌘", "O"])
	})

	it("renders Mod combos with text labels on windows", () => {
		expect(comboDisplayTokens("Mod+K", "windows")).toEqual(["Ctrl", "K"])
	})

	it("renders special keys with display symbols", () => {
		expect(comboDisplayTokens("Escape", "mac")).toEqual(["Esc"])
		expect(comboDisplayTokens("ArrowDown", "mac")).toEqual(["↓"])
		expect(comboDisplayTokens("Space", "mac")).toEqual(["Space"])
	})

	it("uppercases single letters", () => {
		expect(comboDisplayTokens("D", "windows")).toEqual(["D"])
	})
})

describe("shortcutDisplayAlternates", () => {
	it("honors the display override", () => {
		expect(shortcutDisplayAlternates("help.shortcuts", "mac")).toEqual([["?"]])
	})

	it("includes aliases as alternates", () => {
		const id: ShortcutId = "list.next"
		expect(shortcutDisplayAlternates(id, "mac")).toEqual([["J"], ["↓"]])
	})
})
