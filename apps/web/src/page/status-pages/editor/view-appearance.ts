import type { V2StatusPage } from "@maple/domain/http/v2"
import {
	DEFAULT_STATUS_PAGE_THEME,
	isStatusPageImageDataUrl,
	STATUS_PAGE_IMAGE_TYPES,
	STATUS_PAGE_MAX_IMAGE_BYTES,
	resolveStatusPageTheme,
	StatusPageThemeFont,
	StatusPageThemeRadius,
	type StatusPageThemeTokens,
} from "@maple/domain/status-page"
import { previewSnapshot } from "@maple/status-page"
import { Schema, Array as Arr, String as Str } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { colorPicker } from "@maple/views/ui/color-picker"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { skeleton } from "@maple/views/ui/skeleton"
import { heading } from "@maple/views/ui/heading"
import { settingsSection } from "../../kit/settings-section"
import { switchRow } from "../../kit/switch-row"
import { selectField, textField } from "../shared/fields"
import {
	type BrandingField,
	type SettingsForm,
	THEME_OVERRIDE_FIELDS,
	type ThemeColorField,
	type ThemeForm,
	settingsIssues,
	themeColorIssues,
	themeContrastOf,
	themeOf,
} from "../shared/form"
import { icon } from "@maple/views/ui/icon"
import { imageDropzone } from "../../kit/image-dropzone"
import { brandingInputId } from "./command"
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

// The Appearance tab's Branding and Appearance sections and the live preview of the public page.

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
	title: string
	hint: string
	placeholder: string
}> = [
	{
		field: "logoUrl",
		title: "Logo",
		hint: "In the page header. Also the image when the page is shared, if it is a link.",
		placeholder: "https://acme.example/logo.svg",
	},
	{
		field: "logoDarkUrl",
		title: "Dark mode logo",
		hint: "Shown instead of the logo on a dark page.",
		placeholder: "https://acme.example/logo-dark.svg",
	},
	{
		field: "faviconUrl",
		title: "Favicon",
		hint: "The icon in the browser tab and in your list of status pages.",
		placeholder: "https://acme.example/favicon.png",
	},
]

const IMAGE_ACCEPT = Arr.join(STATUS_PAGE_IMAGE_TYPES, ",")
const UPLOAD_HINT = `Drop or upload a PNG, JPEG, WebP, GIF, SVG or ICO up to ${STATUS_PAGE_MAX_IMAGE_BYTES / 1024} KB, or link one below.`

/** One logo or favicon: upload or drop a file, or link an https URL. */
const brandingImageField = (
	h: H,
	model: Model,
	form: SettingsForm,
	entry: (typeof BRANDING_IMAGES)[number],
	error: string | null,
): Html => {
	const value = Str.trim(form[entry.field])
	const isUpload = isStatusPageImageDataUrl(value)
	const isReadOnly = !canManage(model)
	const preview =
		value !== "" && error === null
			? h.img([h.Src(value), h.Alt(""), h.Class("max-h-full max-w-full object-contain")])
			: icon(h, "UploadIcon", { className: "size-5 text-muted-foreground" })
	return vstack(h, { gap: "2" }, [
		imageDropzone(h, {
			inputId: brandingInputId(entry.field),
			title: entry.title,
			hint: `${entry.hint} ${UPLOAD_HINT}`,
			accept: IMAGE_ACCEPT,
			isWide: entry.field !== "faviconUrl",
			preview,
			isUploading: false,
			isDragging: model.brandingDrag === entry.field,
			isReadOnly,
			targetLabel: `Upload ${Str.toLowerCase(entry.title)}`,
			changeLabel: "Upload",
			onPick: Message.ClickedPickBrandingImage({ field: entry.field }),
			onFiles: (files) => Message.PickedBrandingImage({ field: entry.field, files }),
			onDragOver: Message.DraggedOverBrandingImage({ field: entry.field }),
			onDragLeave: Message.LeftBrandingImage(),
			...(value !== "" && { onRemove: Message.ChangedSetting({ field: entry.field, value: "" }) }),
		}),
		textField(h, {
			id: `status-page-${entry.field}`,
			label: `${entry.title} URL`,
			// An upload is a long data: URL; the field offers a link in its place instead of showing it.
			value: isUpload ? "" : form[entry.field],
			placeholder: isUpload ? "Uploaded image. Paste an https URL to replace it." : entry.placeholder,
			isDisabled: isReadOnly,
			error,
			onInput: (next) => Message.ChangedSetting({ field: entry.field, value: next }),
		}),
	])
}

/** The logos and tab icon: what carries the brand besides the colours. */
export const brandingSection = (h: H, model: Model, form: SettingsForm): Html => {
	const issues = settingsIssues(form)
	return settingsSection(
		h,
		{
			id: "status-page-settings-branding",
			title: "Branding",
			description: ["Your logo in the page header, the icon in the browser tab and the footer credit."],
		},
		[
			vstack(
				h,
				{ gap: "5" },
				Arr.map(BRANDING_IMAGES, (entry) =>
					brandingImageField(h, model, form, entry, issues[entry.field]),
				),
			),
			switchRow(h, {
				id: "status-page-powered-by",
				label: "Show powered by Maple",
				description: "A small credit in the page footer.",
				isChecked: form.showPoweredBy,
				isDisabled: !canManage(model),
				onToggle: Message.ToggledPoweredBy(),
				className: "mt-4 border-t pt-4",
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
