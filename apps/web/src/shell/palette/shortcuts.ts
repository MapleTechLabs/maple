import { Schema } from "effect"

// The registry the shortcuts dialog renders, with the display tokens
// of `@tanstack/hotkeys` (`parseHotkey`, `MODIFIER_ORDER`, the symbol tables) for its few combos.

export const Platform = Schema.Literals(["mac", "windows", "linux"])
export type Platform = typeof Platform.Type

export const SHORTCUT_GROUPS = [
	"Global",
	"Search & time",
	"Lists & tables",
	"Agent sessions",
	"Session replay",
] as const

type Group = (typeof SHORTCUT_GROUPS)[number]
type Modifier = "Mod" | "Shift"
type Combo = Readonly<{ modifiers?: ReadonlyArray<Modifier>; key: string }>

export type ShortcutDef = Readonly<{
	label: string
	group: Group
	combo: Combo
	aliases?: ReadonlyArray<Combo>
	display?: ReadonlyArray<string>
}>

const key = (name: string): Combo => ({ key: name })

export const SHORTCUTS: ReadonlyArray<ShortcutDef> = [
	{ label: "Open command palette", group: "Global", combo: { modifiers: ["Mod"], key: "K" } },
	{ label: "Show keyboard shortcuts", group: "Global", combo: key("?"), display: ["?"] },
	{ label: "Toggle dark / light mode", group: "Global", combo: key("T") },
	{ label: "Focus search", group: "Search & time", combo: key("/") },
	{ label: "Open time range picker", group: "Search & time", combo: key("D") },
	{ label: "Open advanced filter (traces)", group: "Search & time", combo: key("F") },
	{ label: "Next row", group: "Lists & tables", combo: key("J"), aliases: [key("ArrowDown")] },
	{ label: "Previous row", group: "Lists & tables", combo: key("K"), aliases: [key("ArrowUp")] },
	{ label: "Open focused row", group: "Lists & tables", combo: key("Enter") },
	{ label: "Toggle selection (issues)", group: "Lists & tables", combo: key("X") },
	{ label: "Change status of focused issue", group: "Lists & tables", combo: key("S") },
	{ label: "Change severity of focused issue", group: "Lists & tables", combo: key("P") },
	{ label: "Clear focus / selection", group: "Lists & tables", combo: key("Escape") },
	{ label: "Overview view", group: "Agent sessions", combo: key("1") },
	{ label: "Traces view", group: "Agent sessions", combo: key("2") },
	{ label: "Flow view", group: "Agent sessions", combo: key("3") },
	{ label: "Transcript view", group: "Agent sessions", combo: key("4") },
	{ label: "Play / pause replay", group: "Session replay", combo: key("Space") },
	{ label: "Seek back 5s", group: "Session replay", combo: key("ArrowLeft") },
	{ label: "Seek forward 5s", group: "Session replay", combo: key("ArrowRight") },
]

/** `KEY_DISPLAY_SYMBOLS` for the keys the registry binds. */
const KEY_SYMBOLS: ReadonlyMap<string, string> = new Map([
	["ArrowUp", "↑"],
	["ArrowDown", "↓"],
	["ArrowLeft", "←"],
	["ArrowRight", "→"],
	["Enter", "↵"],
	["Escape", "Esc"],
])

/** `MODIFIER_ORDER` (Control, Alt, Shift, Meta) after `Mod` resolves to Meta on a Mac. */
const modifierTokens = (modifiers: ReadonlyArray<Modifier>, platform: Platform): ReadonlyArray<string> => {
	const hasShift = modifiers.includes("Shift")
	const hasMod = modifiers.includes("Mod")
	if (platform === "mac") return [...(hasShift ? ["⇧"] : []), ...(hasMod ? ["⌘"] : [])]
	return [...(hasMod ? ["Ctrl"] : []), ...(hasShift ? ["Shift"] : [])]
}

/** `comboDisplayTokens`: one token per Kbd chip ("Mod+K" is ["⌘", "K"] on a Mac). */
const comboTokens = (combo: Combo, platform: Platform): ReadonlyArray<string> => [
	...modifierTokens(combo.modifiers ?? [], platform),
	combo.key === "Space" ? "Space" : (KEY_SYMBOLS.get(combo.key) ?? combo.key),
]

/** `shortcutDisplayAlternates`: the primary combo and its aliases, or the `display` override. */
export const displayAlternates = (
	def: ShortcutDef,
	platform: Platform,
): ReadonlyArray<ReadonlyArray<string>> =>
	def.display !== undefined
		? [def.display]
		: [def.combo, ...(def.aliases ?? [])].map((combo) => comboTokens(combo, platform))

/** `detectPlatform` (`@tanstack/hotkeys`), read once at boot. */
export const detectPlatform = (): Platform => {
	const platform = navigator.platform.toLowerCase()
	const userAgent = navigator.userAgent.toLowerCase()
	if (platform.includes("mac") || userAgent.includes("mac")) return "mac"
	if (platform.includes("win") || userAgent.includes("win")) return "windows"
	return "linux"
}
