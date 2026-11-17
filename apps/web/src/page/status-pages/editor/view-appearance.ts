import type { V2StatusPage } from "@maple/domain/http/v2"
import {
	DEFAULT_STATUS_PAGE_THEME,
	STATUS_PAGE_IMAGE_TYPES,
	STATUS_PAGE_MAX_IMAGE_BYTES,
	resolveStatusPageTheme,
	StatusPageThemeFont,
	StatusPageThemeRadius,
	type StatusPageThemeTokens,
} from "@maple/domain/status-page"
import { previewSnapshot } from "@maple/status-page"
import { Option, Schema, Array as Arr, String as Str } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { colorPicker } from "@maple/views/ui/color-picker"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { skeleton } from "@maple/views/ui/skeleton"
import { grid } from "@maple/views/ui/grid"
import { heading } from "@maple/views/ui/heading"
import { settingsSection } from "../../kit/settings-section"
import { switchRow } from "../../kit/switch-row"
import { selectField, textField } from "../shared/fields"
import {
	type BrandingField,
	httpsIssue,
	type SettingsForm,
	THEME_OVERRIDE_FIELDS,
	type ThemeColorField,
	type ThemeForm,
	settingsIssues,
	themeColorIssues,
	themeContrastOf,
	themeOf,
} from "../shared/form"
import { imageSourceDialog, imageSourceField } from "../../kit/image-source-field"
import { brandingFieldId } from "./command"
import { Message } from "./message"
import { pageUrlOf } from "./update-domain"
import { canManage, type Model } from "./model"
import { monitorStatusOf } from "../shared/derive"
import { APPEARANCES, presetCards } from "../shared/look"
import {
	daysOf,
	isListedIncident,
	previewControls,
	previewDocument,
	previewExampleNote,
	previewFrame,
	previewTheme,
	simulatePreview,
	toSnapshotIncident,
} from "../shared/preview"
import { componentsOf, incidentsOf, monitorsOf, statusReadsReady } from "./reads"
import { typography } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
import { toEpochMs } from "@maple/ui/lib/time-format"

// The Appearance tab's Branding, Appearance and Links sections and the live preview of the public page.

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
	const picked = Str.trim(value) === "" || error !== null ? preset : Str.toLowerCase(Str.trim(value))
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
		...(!isDisabled
			? [
					colorPicker(h, {
						id: `status-page-theme-${entry.field}-picker`,
						value: picked,
						label: `${entry.label} color`,
						onInput: (next) => Message.ChangedThemeColor({ field: entry.field, value: next }),
						onMount: Message.CompletedMountColorPicker(),
					}),
				]
			: []),
	])
}

const BRANDING_IMAGES: ReadonlyArray<{
	field: BrandingField
	label: string
	description: string
	linkPlaceholder: string
}> = [
	{
		field: "logoUrl",
		label: "Logo",
		description: "In the page header.",
		linkPlaceholder: "https://acme.example/logo.svg",
	},
	{
		field: "logoDarkUrl",
		label: "Dark mode logo",
		description: "Optional. Replaces the logo on a dark page.",
		linkPlaceholder: "https://acme.example/logo-dark.svg",
	},
	{
		field: "faviconUrl",
		label: "Favicon",
		description: "In the browser tab and your list of status pages.",
		linkPlaceholder: "https://acme.example/favicon.png",
	},
]

const IMAGE_ACCEPT = Arr.join(STATUS_PAGE_IMAGE_TYPES, ",")
const IMAGE_FORMATS = `PNG, JPG, WebP, GIF, SVG or ICO · max ${STATUS_PAGE_MAX_IMAGE_BYTES / 1024} KB`

/** The page's own background behind each logo, so it previews as visitors see it. */
const logoBackground = (theme: ThemeForm, field: BrandingField): string => {
	const resolved = resolveStatusPageTheme({ ...DEFAULT_STATUS_PAGE_THEME, preset: theme.preset })
	return field === "logoDarkUrl" || theme.appearance === "dark" ? resolved.dark.bg : resolved.light.bg
}

const brandingImageField = (
	h: H,
	model: Model,
	form: SettingsForm,
	entry: (typeof BRANDING_IMAGES)[number],
	error: string | null,
): Html => {
	const field = entry.field
	return imageSourceField(h, {
		id: brandingFieldId(field),
		label: entry.label,
		description: entry.description,
		value: Str.trim(form[field]),
		error,
		preview:
			field === "faviconUrl"
				? { _tag: "Favicon", title: Str.trim(form.name) === "" ? "Status" : Str.trim(form.name) }
				: { _tag: "Logo", background: logoBackground(form.theme, field) },
		accept: IMAGE_ACCEPT,
		isReadOnly: !canManage(model),
		onEdit: Message.ClickedEditBrandingImage({ field }),
		onRemove: Message.ChangedSetting({ field, value: "" }),
		onFiles: (files) => Message.PickedBrandingImage({ field, files }),
	})
}

/** Upload, drop or link the image the dialog was opened on. */
export const brandingImageDialog = (h: H, model: Model): Html => {
	const field = model.brandingDialogField
	const entry = Arr.findFirst(BRANDING_IMAGES, (image) => image.field === field)
	const link = Str.trim(model.brandingLink)
	return imageSourceDialog(h, {
		slotId: "status-page-branding-image",
		model: model.brandingDialog,
		toParentMessage: (message) => Message.GotBrandingDialogMessage({ message }),
		title: Option.match(entry, { onNone: () => "Image", onSome: (image) => image.label }),
		formats: IMAGE_FORMATS,
		link: model.brandingLink,
		linkError: link === "" ? null : httpsIssue(link),
		linkPlaceholder: Option.match(entry, { onNone: () => "https://", onSome: (image) => image.linkPlaceholder }),
		isDragging: model.brandingDrag === field,
		onBrowse: Message.ClickedPickBrandingImage({ field }),
		onFiles: (files) => Message.PickedBrandingImage({ field, files }),
		onDragOver: Message.DraggedOverBrandingImage({ field }),
		onDragLeave: Message.LeftBrandingImage(),
		onLinkInput: (value) => Message.ChangedBrandingLink({ value }),
		onSubmitLink: Message.SubmittedBrandingLink(),
	})
}

/** The logos and tab icon: what carries the brand besides the colours. */
export const brandingSection = (h: H, model: Model, form: SettingsForm): Html => {
	const issues = settingsIssues(form)
	const field = (index: number) => {
		const entry = BRANDING_IMAGES[index]
		return entry === undefined ? [] : [brandingImageField(h, model, form, entry, issues[entry.field])]
	}
	return settingsSection(
		h,
		{
			id: "status-page-settings-branding",
			title: "Branding",
			description: ["Upload an image or link one. Unsaved changes show in the preview."],
		},
		[
			vstack(h, { gap: "6" }, [
				grid(h, { sm: 2, gap: "6" }, [...field(0), ...field(1)]),
				grid(h, { sm: 2, gap: "6" }, field(2)),
			]),
			switchRow(h, {
				id: "status-page-powered-by",
				label: "Show powered by Maple",
				description: "A small credit in the page footer.",
				isChecked: form.showPoweredBy,
				isDisabled: !canManage(model),
				onToggle: Message.ToggledPoweredBy(),
				className: "mt-6 border-t pt-4",
			}),
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
			title: "Appearance",
			description: ["Colors, corners and type of the public page."],
		},
		[
			vstack(h, { gap: "5" }, [
				vstack(h, { gap: "1.5" }, [
					typography(h, { size: "xs", tone: "muted" }, ["Theme"]),
					presetCards(h, {
						selected: theme.preset,
						isDisabled: isReadOnly,
						onPick: (preset) => Message.PickedThemePreset({ preset }),
					}),
					typography(h, { size: "xs", tone: "muted", as: "p" }, [
						"A starting point, not a lock-in. Everything below overrides it: colors, corners and font. Picking another theme resets corners and font and keeps your colors. Only the status colors (operational, degraded, outage, maintenance) always come from the theme.",
					]),
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
				h.div(
					[h.Class("grid gap-4 sm:grid-cols-2")],
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
			]),
		],
	)
}

const LINK_FIELDS: ReadonlyArray<{
	field: "websiteUrl" | "supportUrl" | "privacyUrl" | "termsUrl"
	id: string
	label: string
	placeholder: string
	hint: string
}> = [
	{
		field: "websiteUrl",
		id: "status-page-website",
		label: "Website URL",
		placeholder: "https://acme.example",
		hint: "In the page header as Visit website.",
	},
	{
		field: "supportUrl",
		id: "status-page-support",
		label: "Support URL",
		placeholder: "https://acme.example/support",
		hint: "In the page header as Contact support.",
	},
	{
		field: "privacyUrl",
		id: "status-page-privacy",
		label: "Privacy policy URL",
		placeholder: "https://acme.example/privacy",
		hint: "In the page footer.",
	},
	{
		field: "termsUrl",
		id: "status-page-terms",
		label: "Terms of service URL",
		placeholder: "https://acme.example/terms",
		hint: "In the page footer.",
	},
]

/** The header and footer links back to the customer's own site. */
export const linksSection = (h: H, model: Model, form: SettingsForm): Html => {
	const issues = settingsIssues(form)
	return settingsSection(
		h,
		{
			id: "status-page-settings-links",
			title: "Links",
			description: ["Links on the page back to your own site. Leave one empty to hide it."],
		},
		[
			grid(
				h,
				{ sm: 2, gap: "4" },
				Arr.map(LINK_FIELDS, (entry) =>
					textField(h, {
						id: entry.id,
						label: entry.label,
						value: form[entry.field],
						placeholder: entry.placeholder,
						isDisabled: !canManage(model),
						error: issues[entry.field],
						hint: entry.hint,
						onInput: (value) => Message.ChangedSetting({ field: entry.field, value }),
					}),
				),
			),
		],
	)
}

const orNull = (value: string): string | null => (Str.trim(value) === "" ? null : Str.trim(value))

/** The public page as the draft would render it, from the loaded components and incidents. */
export const settingsDocument = (model: Model, page: V2StatusPage, form: SettingsForm): string => {
	const nowMs = model.nowMs ?? toEpochMs(page.updated_at)
	const monitors = monitorsOf(model)
	const shown = simulatePreview(model.previewState, {
		components: Arr.map(componentsOf(model), (component) => ({
			id: component.id,
			name: component.name,
			description: component.description,
			group: component.group,
			monitorStatus: monitorStatusOf(monitors, component.monitor_id),
			manualStatus: component.manual_status,
			showUptime: component.show_uptime,
			monitored: component.monitor_id !== null,
			days: daysOf(model.previewHistory, component.monitor_id),
		})),
		incidents: Arr.map(
			Arr.filter(incidentsOf(model), (incident) => isListedIncident(incident, nowMs)),
			toSnapshotIncident,
		),
		nowMs,
	})
	const snapshot = previewSnapshot({
		pageId: page.id,
		page: {
			name: Str.trim(form.name) === "" ? page.name : Str.trim(form.name),
			slug: form.slug,
			description: orNull(form.description),
			websiteUrl: orNull(form.websiteUrl),
			logoUrl: orNull(form.logoUrl),
			logoDarkUrl: orNull(form.logoDarkUrl),
			faviconUrl: orNull(form.faviconUrl),
			supportUrl: orNull(form.supportUrl),
			privacyUrl: orNull(form.privacyUrl),
			termsUrl: orNull(form.termsUrl),
			customDomain: null,
			visibility: page.visibility,
			showPoweredBy: form.showPoweredBy,
			theme: previewTheme(themeOf(form.theme), model.previewScheme),
		},
		components: shown.components,
		incidents: shown.incidents,
		nowMs,
	})
	return previewDocument({
		snapshot,
		nowMs,
		isSelectable: false,
		selectedIds: [],
		publicUrl: pageUrlOf(model, page),
	})
}

export const previewPanel = (h: H, model: Model, page: V2StatusPage, form: SettingsForm): Html =>
	vstack(
		h,
		{
			gap: "3",
			shrink: true,
			as: "section",
			className: "xl:sticky xl:top-6",
			attributes: [h.AriaLabelledBy("status-page-preview-title")],
		},
		[
			hstack(h, { gap: "3", justify: "between", wrap: true, className: "min-h-7" }, [
				heading(h, { level: 2, variant: "subsection", id: "status-page-preview-title" }, ["Preview"]),
				previewControls(h, {
					state: model.previewState,
					width: model.previewWidth,
					scheme: form.theme.appearance === "auto" ? model.previewScheme : null,
					onState: (state) => Message.PickedPreviewState({ state }),
					onWidth: (width) => Message.PickedPreviewWidth({ width }),
					onScheme: (scheme) => Message.PickedPreviewScheme({ scheme }),
				}),
			]),
			...previewExampleNote(h, model.previewState),
			statusReadsReady(model)
				? previewFrame(h, {
						title: "Status page preview",
						document: settingsDocument(model, page, form),
						width: model.previewWidth,
						className: "h-[640px]",
					})
				: skeleton(h, "h-[640px] w-full"),
			typography(h, { size: "xs", tone: "muted", as: "p" }, ["Unsaved changes show here first."]),
		],
	)
