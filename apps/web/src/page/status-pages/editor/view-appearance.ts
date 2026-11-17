import type { V2StatusPage } from "@maple/domain/http/v2"
import {
	DEFAULT_STATUS_PAGE_THEME,
	resolveStatusPageTheme,
	StatusPageThemeFont,
	StatusPageThemeRadius,
	type StatusPageThemeTokens,
} from "@maple/domain/status-page"
import { Schema, Array as Arr, String as Str } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { colorInput } from "@maple/views/ui/color-input"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { settingsSection } from "../../kit/settings-section"
import { selectField, textField } from "../shared/fields"
import {
	type SettingsForm,
	THEME_OVERRIDE_FIELDS,
	type ThemeColorField,
	type ThemeForm,
	settingsIssues,
	themeColorIssues,
	themeContrastOf,
} from "../shared/form"
import { Message } from "./message"
import { canManage, type Model } from "./model"
import { APPEARANCES, presetCards } from "../shared/look"
import { onYourPage } from "../shared/preview"
import { tabPreview } from "./view-canvas"
import { typography } from "@maple/views/ui/typography"
import { grid } from "@maple/views/ui/grid"
import { hstack, vstack } from "@maple/views/ui/stack"

// Settings > Appearance: the brand (logos, tab icon) and the theme, each with how it reads on the page.

type H = HtmlBuilder<Message>

const RADII: ReadonlyArray<{ value: StatusPageThemeRadius; label: string }> = [
	{ value: "none", label: "Square" },
	{ value: "sm", label: "Small" },
	{ value: "md", label: "Medium" },
	{ value: "lg", label: "Large" },
]

const FONTS: ReadonlyArray<{ value: StatusPageThemeFont; label: string }> = [
	{ value: "sans", label: "Sans serif" },
	{ value: "serif", label: "Serif" },
	{ value: "mono", label: "Monospace" },
]

/** Each input's placeholder is the preset's own colour, from the token it overrides. */
const COLOR_FIELDS: ReadonlyArray<{
	field: ThemeColorField
	label: string
	token: keyof StatusPageThemeTokens
}> = [
	{ field: "accent", label: "Accent", token: "link" },
	{ field: "background", label: "Background", token: "bg" },
	{ field: "text", label: "Text", token: "fg" },
	{ field: "card", label: "Card", token: "card" },
	{ field: "border", label: "Border", token: "line" },
]

/** The preset's tokens in the page's mode (Auto shows the light ones). */
const presetTokens = (theme: ThemeForm): StatusPageThemeTokens => {
	const resolved = resolveStatusPageTheme({ ...DEFAULT_STATUS_PAGE_THEME, preset: theme.preset })
	return theme.appearance === "dark" ? resolved.dark : resolved.light
}

const isRadius = Schema.is(StatusPageThemeRadius)
const isFont = Schema.is(StatusPageThemeFont)
const isOverride = (field: ThemeColorField): boolean =>
	Arr.some(THEME_OVERRIDE_FIELDS, (override) => override === field)

const colorField = (
	h: H,
	theme: ThemeForm,
	entry: (typeof COLOR_FIELDS)[number],
	error: string | null,
	isDisabled: boolean,
): Html => {
	const value = theme[entry.field]
	const preset = presetTokens(theme)[entry.token]
	// The picker opens on the colour in effect: the typed one, or the preset's when the field is empty.
	const picked = Str.trim(value) === "" ? preset : Str.toLowerCase(Str.trim(value))
	return hstack(h, { gap: "2", align: "end" }, [
		textField(h, {
			id: `status-page-theme-${entry.field}`,
			label: entry.label,
			value,
			placeholder: preset,
			isMono: true,
			isDisabled,
			error,
			className: "flex-1",
			onInput: (next) => Message.ChangedThemeColor({ field: entry.field, value: next }),
		}),
		...(error === null && !isDisabled
			? [
					colorInput(h, {
						value: picked,
						label: `${entry.label} color`,
						onInput: (next) => Message.ChangedThemeColor({ field: entry.field, value: next }),
					}),
				]
			: []),
	])
}

/** The logos and tab icon: what carries the brand besides the colours. */
export const brandingSection = (h: H, model: Model, page: V2StatusPage, form: SettingsForm): Html => {
	const issues = settingsIssues(form)
	const isReadOnly = !canManage(model)
	return settingsSection(
		h,
		{
			id: "status-page-settings-branding",
			title: "Branding",
			description: [
				"Your logo in the page header and the icon in the browser tab. Without a logo, the page shows its initial in your accent colour.",
			],
		},
		[
			vstack(h, { gap: "4" }, [
				grid(h, { sm: 2, gap: "4" }, [
					textField(h, {
						id: "status-page-logo",
						label: "Logo URL",
						value: form.logoUrl,
						placeholder: "https://acme.example/logo.svg",
						isDisabled: isReadOnly,
						error: issues.logoUrl,
						hint: "Also the image when the page is shared.",
						onInput: (value) => Message.ChangedSetting({ field: "logoUrl", value }),
					}),
					textField(h, {
						id: "status-page-logo-dark",
						label: "Dark mode logo URL",
						value: form.logoDarkUrl,
						placeholder: "https://acme.example/logo-dark.svg",
						isDisabled: isReadOnly,
						error: issues.logoDarkUrl,
						hint: "Shown instead of the logo on a dark page.",
						onInput: (value) => Message.ChangedSetting({ field: "logoDarkUrl", value }),
					}),
					textField(h, {
						id: "status-page-favicon",
						label: "Favicon URL",
						value: form.faviconUrl,
						placeholder: "https://acme.example/favicon.png",
						isDisabled: isReadOnly,
						error: issues.faviconUrl,
						onInput: (value) => Message.ChangedSetting({ field: "faviconUrl", value }),
					}),
				]),
				onYourPage(h, tabPreview(h, page, form, null)),
			]),
		],
	)
}

export const appearanceSection = (h: H, model: Model, form: SettingsForm): Html => {
	const theme = form.theme
	const isReadOnly = !canManage(model)
	const isAuto = theme.appearance === "auto"
	const issues = themeColorIssues(theme)
	const contrast = themeContrastOf(theme)
	return settingsSection(
		h,
		{
			id: "status-page-settings-appearance",
			title: "Theme",
			description: ["Colors, corners and type of the public page."],
		},
		[
			vstack(h, { gap: "5" }, [
				vstack(h, { gap: "1.5" }, [
					typography(h, { size: "xs", tone: "muted" }, ["Preset"]),
					presetCards(h, {
						selected: theme.preset,
						isDisabled: isReadOnly,
						onPick: (preset) => Message.PickedThemePreset({ preset }),
					}),
				]),
				vstack(h, { gap: "1.5" }, [
					typography(h, { size: "xs", tone: "muted" }, ["Mode"]),
					segmentedSelect(h, {
						size: "sm",
						ariaLabel: "Mode",
						className: "self-start",
						value: theme.appearance,
						onChange: (appearance) => Message.PickedThemeAppearance({ appearance }),
						options: Arr.map(APPEARANCES, (option) => ({ ...option, isDisabled: isReadOnly })),
					}),
					typography(h, { size: "xs", tone: "muted", as: "p" }, [
						isAuto
							? "Follows each visitor's light or dark setting. Pick Light or Dark to set your own colors."
							: `Every visitor sees the ${theme.appearance} page.`,
					]),
				]),
				grid(
					h,
					{ sm: 2, gap: "4" },
					Arr.map(COLOR_FIELDS, (entry) =>
						colorField(
							h,
							theme,
							entry,
							issues[entry.field],
							isReadOnly || (isAuto && isOverride(entry.field)),
						),
					),
				),
				...(contrast === null
					? []
					: [
							alert(h, { variant: "warn", size: "sm" }, [
								alertTitle(h, ["Text is hard to read"]),
								alertDescription(h, [contrast]),
							]),
						]),
				grid(h, { sm: 2, gap: "4" }, [
					selectField(h, {
						id: "status-page-theme-radius",
						label: "Corners",
						value: theme.radius,
						entries: RADII,
						isDisabled: isReadOnly,
						onInput: (value) =>
							Message.PickedThemeRadius({
								radius: isRadius(value) ? value : theme.radius,
							}),
					}),
					selectField(h, {
						id: "status-page-theme-font",
						label: "Font",
						value: theme.font,
						entries: FONTS,
						isDisabled: isReadOnly,
						onInput: (value) =>
							Message.PickedThemeFont({ font: isFont(value) ? value : theme.font }),
					}),
				]),
			]),
		],
	)
}
