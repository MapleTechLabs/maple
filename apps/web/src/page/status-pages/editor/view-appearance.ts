import type { V2StatusPage } from "@maple/domain/http/v2"
import {
	DEFAULT_STATUS_PAGE_THEME,
	resolveStatusPageTheme,
	StatusPageThemeFont,
	StatusPageThemeRadius,
	type StatusPageThemeTokens,
} from "@maple/domain/status-page"
import { previewSnapshot } from "@maple/status-page"
import { Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "../../../ui/alert"
import { segmentedSelect } from "../../../ui/segmented-select"
import { skeleton } from "../../../ui/skeleton"
import { heading } from "../../../ui/heading"
import { settingsSection } from "../../settings/kit/section"
import { selectField, textField } from "../shared/fields"
import {
	type SettingsForm,
	THEME_OVERRIDE_FIELDS,
	type ThemeColorField,
	type ThemeForm,
	themeColorIssues,
	themeContrastOf,
	themeOf,
} from "../shared/form"
import { Message } from "./message"
import type { Model } from "./model"
import { isoMs } from "../../alerts/shared/time"
import { APPEARANCES, presetCards } from "../shared/look"
import {
	daysOf,
	isListedIncident,
	previewDocument,
	previewFrame,
	previewTheme,
	toSnapshotIncident,
} from "../shared/preview"
import { componentsOf, incidentsOf, monitorsOf, statusReadsReady } from "./reads"

// The Settings view's Appearance section and the live preview of the public page.

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
	THEME_OVERRIDE_FIELDS.some((override) => override === field)

const colorField = (
	h: H,
	theme: ThemeForm,
	entry: (typeof COLOR_FIELDS)[number],
	error: string | null,
	isDisabled: boolean,
): Html => {
	const value = theme[entry.field]
	const showSwatch = error === null && value.trim() !== "" && !isDisabled
	return h.div(
		[h.Class("flex items-end gap-2")],
		[
			textField(h, {
				id: `status-page-theme-${entry.field}`,
				label: entry.label,
				value,
				placeholder: presetTokens(theme)[entry.token],
				isMono: true,
				isDisabled,
				error,
				className: "flex-1",
				onInput: (next) => Message.ChangedThemeColor({ field: entry.field, value: next }),
			}),
			...(showSwatch
				? [
						h.span(
							[
								h.AriaHidden(true),
								h.Class("mb-1.5 size-6 shrink-0 rounded-md border"),
								h.Style({ backgroundColor: value.trim() }),
							],
							[],
						),
					]
				: []),
		],
	)
}

export const appearanceSection = (h: H, model: Model, form: SettingsForm): Html => {
	const theme = form.theme
	const isReadOnly = !model.isAdmin
	const isAuto = theme.appearance === "auto"
	const issues = themeColorIssues(theme)
	const contrast = themeContrastOf(theme)
	return settingsSection(
		h,
		{
			id: "status-page-settings-appearance",
			title: "Appearance",
			description: ["Colors, corners and type of the public page."],
		},
		[
			h.div(
				[h.Class("flex flex-col gap-5")],
				[
					h.div(
						[h.Class("flex flex-col gap-1.5")],
						[
							h.span([h.Class("text-xs text-muted-foreground")], ["Preset"]),
							presetCards(h, {
								selected: theme.preset,
								isDisabled: isReadOnly,
								onPick: (preset) => Message.PickedThemePreset({ preset }),
							}),
						],
					),
					h.div(
						[h.Class("flex flex-col gap-1.5")],
						[
							h.span([h.Class("text-xs text-muted-foreground")], ["Mode"]),
							segmentedSelect(h, {
								size: "sm",
								ariaLabel: "Mode",
								className: "self-start",
								value: theme.appearance,
								onChange: (appearance) => Message.PickedThemeAppearance({ appearance }),
								options: APPEARANCES.map((option) => ({ ...option, isDisabled: isReadOnly })),
							}),
							h.p(
								[h.Class("text-xs text-muted-foreground")],
								[
									isAuto
										? "Follows each visitor's light or dark setting. Pick Light or Dark to set your own colors."
										: `Every visitor sees the ${theme.appearance} page.`,
								],
							),
						],
					),
					h.div(
						[h.Class("grid gap-4 sm:grid-cols-2")],
						COLOR_FIELDS.map((entry) =>
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
					h.div(
						[h.Class("grid gap-4 sm:grid-cols-2")],
						[
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
						],
					),
				],
			),
		],
	)
}

// PREVIEW

const orNull = (value: string): string | null => (value.trim() === "" ? null : value.trim())

/** The public page as the draft would render it, from the loaded components and incidents. */
export const settingsDocument = (model: Model, page: V2StatusPage, form: SettingsForm): string => {
	const nowMs = model.nowMs ?? isoMs(page.updated_at)
	const monitors = monitorsOf(model)
	const snapshot = previewSnapshot({
		pageId: page.id,
		page: {
			name: form.name.trim() === "" ? page.name : form.name.trim(),
			slug: form.slug,
			description: orNull(form.description),
			websiteUrl: orNull(form.websiteUrl),
			logoUrl: orNull(form.logoUrl),
			privacyUrl: orNull(form.privacyUrl),
			termsUrl: orNull(form.termsUrl),
			showPoweredBy: form.showPoweredBy,
			theme: previewTheme(themeOf(form.theme), model.previewScheme),
		},
		components: componentsOf(model).map((component) => ({
			id: component.id,
			name: component.name,
			description: component.description,
			group: component.group,
			monitorStatus:
				monitors.find((monitor) => monitor.id === component.monitor_id)?.state.status ?? null,
			manualStatus: component.manual_status,
			showUptime: component.show_uptime,
			monitored: component.monitor_id !== null,
			days: daysOf(model.previewHistory, component.monitor_id),
		})),
		incidents: incidentsOf(model)
			.filter((incident) => isListedIncident(incident, nowMs))
			.map(toSnapshotIncident),
		nowMs,
	})
	return previewDocument({ snapshot, nowMs, isSelectable: false, selectedIds: [] })
}

export const previewPanel = (h: H, model: Model, page: V2StatusPage, form: SettingsForm): Html =>
	h.section(
		[
			h.AriaLabelledBy("status-page-preview-title"),
			h.Class("flex min-w-0 flex-col gap-3 xl:sticky xl:top-6"),
		],
		[
			h.div(
				[h.Class("flex min-h-7 items-center justify-between gap-3")],
				[
					heading(h, { level: 2, variant: "subsection", id: "status-page-preview-title" }, [
						"Preview",
					]),
					...(form.theme.appearance === "auto"
						? [
								segmentedSelect(h, {
									size: "xs",
									ariaLabel: "Preview mode",
									value: model.previewScheme,
									onChange: (scheme) => Message.PickedPreviewScheme({ scheme }),
									options: [
										{ value: "light", label: "Light" },
										{ value: "dark", label: "Dark" },
									],
								}),
							]
						: []),
				],
			),
			statusReadsReady(model)
				? previewFrame(h, {
						title: "Status page preview",
						document: settingsDocument(model, page, form),
						className: "h-[640px]",
					})
				: skeleton(h, "h-[640px] w-full"),
			h.p([h.Class("text-xs text-muted-foreground")], ["Unsaved changes show here first."]),
		],
	)
