import type { V2StatusPage, V2StatusPageIncident } from "@maple/domain/http/v2"
import {
	DEFAULT_STATUS_PAGE_THEME,
	resolveStatusPageTheme,
	STATUS_PAGE_INCIDENT_HISTORY_DAYS,
	type StatusPageSnapshotIncident,
	type StatusPageTheme,
	type StatusPageThemeAppearance,
	StatusPageThemeFont,
	type StatusPageThemePreset,
	StatusPageThemeRadius,
	type StatusPageThemeTokens,
} from "@maple/domain/status-page"
import { previewSnapshot, renderPage } from "@maple/status-page"
import { cn } from "@maple/ui/lib/utils"
import { Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "../../../../ui/alert"
import { segmentedSelect } from "../../../../ui/segmented-select"
import { settingsSection } from "../../../settings/kit/section"
import { isoMs } from "../../shared/time"
import { selectField, textField } from "../fields"
import {
	type SettingsForm,
	THEME_OVERRIDE_FIELDS,
	type ThemeColorField,
	type ThemeForm,
	themeColorIssues,
	themeContrastOf,
	themeOf,
} from "./form"
import { Message } from "./message"
import type { Model, PreviewScheme } from "./model"
import { componentsOf, incidentsOf, monitorsOf } from "./reads"

// The Settings tab's Appearance section and the live preview of the public page.

type H = HtmlBuilder<Message>

const PRESETS: ReadonlyArray<{ value: StatusPageThemePreset; label: string }> = [
	{ value: "default", label: "Default" },
	{ value: "mono", label: "Mono" },
	{ value: "midnight", label: "Midnight" },
	{ value: "paper", label: "Paper" },
]

const APPEARANCES: ReadonlyArray<{ value: StatusPageThemeAppearance; label: string }> = [
	{ value: "auto", label: "Auto" },
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
]

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

/** One preset as a small card: its light and dark page colours side by side. */
const presetCard = (h: H, theme: ThemeForm, preset: (typeof PRESETS)[number], isDisabled: boolean): Html => {
	const tokens = resolveStatusPageTheme({ ...DEFAULT_STATUS_PAGE_THEME, preset: preset.value })
	const isSelected = theme.preset === preset.value
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
						h.span([h.Class("h-2 w-1.5 rounded-[1px]"), h.Style({ backgroundColor: color })], []),
					),
				),
			],
		)
	return h.button(
		[
			h.Type("button"),
			h.Key(preset.value),
			h.AriaPressed(isSelected ? "true" : "false"),
			h.Disabled(isDisabled),
			h.OnClick(Message.PickedThemePreset({ preset: preset.value })),
			h.Class(
				cn(
					"flex flex-col gap-1.5 rounded-lg border p-1.5 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60",
					isSelected ? "border-primary/70 bg-primary/5" : "hover:bg-muted/50",
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
							h.div(
								[
									h.Role("group"),
									h.AriaLabel("Preset"),
									h.Class("grid grid-cols-2 gap-2 sm:grid-cols-4"),
								],
								PRESETS.map((preset) => presetCard(h, theme, preset, isReadOnly)),
							),
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

const DAY_MS = 86_400_000

const isListed = (incident: V2StatusPageIncident, nowMs: number): boolean =>
	incident.published &&
	(incident.resolved_at === null ||
		isoMs(incident.resolved_at) >= nowMs - STATUS_PAGE_INCIDENT_HISTORY_DAYS * DAY_MS)

const msOrNull = (value: string | null): number | null => (value === null ? null : isoMs(value))

const toSnapshotIncident = (incident: V2StatusPageIncident): StatusPageSnapshotIncident => ({
	id: incident.id,
	kind: incident.kind,
	title: incident.title,
	impact: incident.impact,
	status: incident.status,
	startedAt: isoMs(incident.started_at),
	resolvedAt: msOrNull(incident.resolved_at),
	scheduledStart: msOrNull(incident.scheduled_start),
	scheduledEnd: msOrNull(incident.scheduled_end),
	componentIds: incident.component_ids,
	openedByOverlayEntryId: null,
	updates: incident.updates
		.map((update) => ({
			id: update.id,
			status: update.status,
			body: update.body,
			at: isoMs(update.created_at),
			source: update.source,
			overlayEntryId: null,
		}))
		.sort((a, b) => b.at - a.at),
})

/** Auto pages preview in the picked scheme, with the overrides Auto ignores left out. */
export const previewTheme = (theme: StatusPageTheme, scheme: PreviewScheme): StatusPageTheme =>
	theme.appearance === "auto"
		? { ...theme, appearance: scheme, background: null, text: null, card: null, border: null }
		: theme

const orNull = (value: string): string | null => (value.trim() === "" ? null : value.trim())

/** The public page as the draft would render it, from the loaded components and incidents. */
export const previewDocument = (model: Model, page: V2StatusPage, form: SettingsForm): string => {
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
		})),
		incidents: incidentsOf(model)
			.filter((incident) => isListed(incident, nowMs))
			.map(toSnapshotIncident),
		nowMs,
	})
	return renderPage(snapshot, { _tag: "live", updatedAt: nowMs }, nowMs)
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
					h.h2(
						[h.Id("status-page-preview-title"), h.Class("text-sm font-medium text-foreground")],
						["Preview"],
					),
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
			h.iframe(
				[
					h.Title("Status page preview"),
					// No scripts, no same-origin access: the page is inert markup and CSS.
					h.Sandbox(""),
					h.Srcdoc(previewDocument(model, page, form)),
					h.Class("h-[640px] w-full rounded-lg border bg-background"),
				],
				[],
			),
			h.p(
				[h.Class("text-xs text-muted-foreground")],
				["Unsaved changes show here first. Uptime bars fill in from your monitors once published."],
			),
		],
	)
