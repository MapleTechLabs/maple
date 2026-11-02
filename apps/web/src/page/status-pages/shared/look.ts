import {
	DEFAULT_STATUS_PAGE_THEME,
	type ResolvedStatusPageTheme,
	resolveStatusPageTheme,
	STATUS_PAGE_PRESET_DEFAULTS,
	type StatusPageThemeAppearance,
	type StatusPageThemePreset,
} from "@maple/domain/status-page"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"

// The theme presets as small cards, shared by the builder's Look and the Settings appearance.

/** Maple in its own colours; the others are named after the shadcn themes they come from. */
export const PRESETS: ReadonlyArray<{ value: StatusPageThemePreset; label: string }> = [
	{ value: "default", label: "Default" },
	{ value: "maple", label: "Maple" },
	{ value: "mono", label: "Mono" },
	{ value: "midnight", label: "Cosmic Night" },
	{ value: "paper", label: "Vintage Paper" },
]

export const APPEARANCES: ReadonlyArray<{ value: StatusPageThemeAppearance; label: string }> = [
	{ value: "auto", label: "Auto" },
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
]

type Scheme = ResolvedStatusPageTheme["light"]

/** One mode of the preset as a tiny page: its brand mark and type, a card, and uptime bars. */
const miniPage = <M>(h: HtmlBuilder<M>, scheme: Scheme, tokens: ResolvedStatusPageTheme): Html => {
	const radius = `${Math.round(tokens.radiusPx / 3)}px`
	return h.span(
		[
			h.Class("flex flex-1 flex-col justify-center gap-1.5 px-2"),
			h.Style({ backgroundColor: scheme.bg, color: scheme.fg, fontFamily: tokens.fontStack }),
		],
		[
			h.span(
				[h.Class("flex items-center gap-1")],
				[
					h.span(
						[
							h.Class("size-2.5"),
							h.Style({ backgroundColor: scheme.primary, borderRadius: radius }),
						],
						[],
					),
					h.span([h.Class("text-xs/none font-semibold")], ["Aa"]),
				],
			),
			h.span(
				[
					h.Class("flex gap-px p-1"),
					h.Style({
						backgroundColor: scheme.card,
						border: `1px solid ${scheme.line}`,
						borderRadius: radius,
					}),
				],
				[scheme.ok, scheme.ok, scheme.ok, scheme.degraded, scheme.ok, scheme.ok].map((color) =>
					h.span([h.Class("h-2 flex-1 rounded-2xs"), h.Style({ backgroundColor: color })], []),
				),
			),
		],
	)
}

/** One preset: its light and dark modes side by side as tiny pages. */
const presetCard = <M>(
	h: HtmlBuilder<M>,
	preset: (typeof PRESETS)[number],
	options: Readonly<{
		selected: StatusPageThemePreset
		isDisabled: boolean
		onPick: (preset: StatusPageThemePreset) => M
	}>,
): Html => {
	const tokens = resolveStatusPageTheme({
		...DEFAULT_STATUS_PAGE_THEME,
		...STATUS_PAGE_PRESET_DEFAULTS[preset.value],
		preset: preset.value,
	})
	const isSelected = options.selected === preset.value
	return h.button(
		[
			h.Type("button"),
			h.Key(preset.value),
			h.AriaPressed(isSelected ? "true" : "false"),
			h.Disabled(options.isDisabled),
			h.OnClick(options.onPick(preset.value)),
			h.Class(
				cn(
					"flex flex-col gap-1.5 rounded-lg border p-1.5 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60",
					isSelected ? "border-primary-a4 bg-primary-a1" : "hover:bg-surface-sunken active:bg-surface-sunken",
				),
			),
		],
		[
			h.span(
				[h.AriaHidden(true), h.Class("flex h-16 overflow-hidden rounded-md border")],
				[miniPage(h, tokens.light, tokens), miniPage(h, tokens.dark, tokens)],
			),
			h.span([h.Class("truncate px-0.5 font-medium text-foreground")], [preset.label]),
		],
	)
}

export const presetCards = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		selected: StatusPageThemePreset
		isDisabled: boolean
		onPick: (preset: StatusPageThemePreset) => M
	}>,
): Html =>
	h.div(
		[h.Role("group"), h.AriaLabel("Preset"), h.Class("grid grid-cols-2 gap-2 sm:grid-cols-3")],
		PRESETS.map((preset) => presetCard(h, preset, options)),
	)
