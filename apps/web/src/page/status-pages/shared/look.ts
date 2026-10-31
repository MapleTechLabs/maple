import {
	DEFAULT_STATUS_PAGE_THEME,
	resolveStatusPageTheme,
	type StatusPageThemeAppearance,
	type StatusPageThemePreset,
} from "@maple/domain/status-page"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"

// The theme presets as small cards, shared by the builder's Look and the Settings appearance.

export const PRESETS: ReadonlyArray<{ value: StatusPageThemePreset; label: string }> = [
	{ value: "default", label: "Default" },
	{ value: "mono", label: "Mono" },
	{ value: "midnight", label: "Midnight" },
	{ value: "paper", label: "Paper" },
]

export const APPEARANCES: ReadonlyArray<{ value: StatusPageThemeAppearance; label: string }> = [
	{ value: "auto", label: "Auto" },
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
]

/** One preset: its light and dark page colours side by side. */
const presetCard = <M>(
	h: HtmlBuilder<M>,
	preset: (typeof PRESETS)[number],
	options: Readonly<{
		selected: StatusPageThemePreset
		isDisabled: boolean
		onPick: (preset: StatusPageThemePreset) => M
	}>,
): Html => {
	const tokens = resolveStatusPageTheme({ ...DEFAULT_STATUS_PAGE_THEME, preset: preset.value })
	const isSelected = options.selected === preset.value
	const half = (scheme: typeof tokens.light) =>
		h.span(
			[
				h.Class("flex flex-1 flex-col justify-center gap-1 px-2"),
				h.Style({ backgroundColor: scheme.bg }),
			],
			[
				h.span([h.Class("h-1 w-8 rounded-full"), h.Style({ backgroundColor: scheme.fg })], []),
				h.span(
					[h.Class("flex gap-0.5")],
					[scheme.ok, scheme.ok, scheme.degraded, scheme.ok].map((color) =>
						h.span([h.Class("h-2 w-1.5 rounded-2xs"), h.Style({ backgroundColor: color })], []),
					),
				),
			],
		)
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
					isSelected ? "border-primary/70 bg-primary-a1" : "hover:bg-muted/50 active:bg-muted/50",
				),
			),
		],
		[
			h.span(
				[h.AriaHidden(true), h.Class("flex h-10 overflow-hidden rounded-md border")],
				[half(tokens.light), half(tokens.dark)],
			),
			h.span([h.Class("px-0.5 font-medium text-foreground")], [preset.label]),
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
		[h.Role("group"), h.AriaLabel("Preset"), h.Class("grid grid-cols-2 gap-2 sm:grid-cols-4")],
		PRESETS.map((preset) => presetCard(h, preset, options)),
	)
