import {
	StatusPageAutoIncidents,
	StatusPageComponentId,
	StatusPageComponentStatus,
	StatusPageIncidentId,
	StatusPageIncidentImpact,
	StatusPageIncidentKind,
	StatusPageIncidentStatus,
	UptimeMonitorId,
} from "@maple/domain"
import type {
	V2StatusPage,
	V2StatusPageComponent,
	V2StatusPageComponentCreateParams,
	V2StatusPageIncidentCreateParams,
	V2StatusPageUpdateParams,
} from "@maple/domain/http/v2"
import {
	STATUS_PAGE_HEX_COLOR_PATTERN,
	StatusPageThemeAppearance,
	StatusPageThemeFont,
	StatusPageThemePreset,
	StatusPageThemeRadius,
	type StatusPageTheme,
	themeContrastIssue,
	STATUS_PAGE_MAX_URL_LENGTH,
} from "@maple/domain/status-page"
import { DateTime, Option, Schema } from "effect"
import { closingStatus, STATUSES_OF_KIND } from "./derive"
import { slugIssue } from "./slug"

// The editor's drafts: each form as its inputs hold it, and the payloads built from them.

// COMPONENTS

export const ComponentTextField = Schema.Literals([
	"name",
	"description",
	"group",
	"monitorId",
	"manualStatus",
])
export type ComponentTextField = typeof ComponentTextField.Type

export const ComponentForm = Schema.Struct({
	/** The component being edited; `null` adds one. */
	editingId: Schema.NullOr(StatusPageComponentId),
	name: Schema.String,
	description: Schema.String,
	group: Schema.String,
	/** The linked monitor's id, `""` for none. */
	monitorId: Schema.String,
	/** The override, `""` to follow the monitor and incidents. */
	manualStatus: Schema.String,
	showUptime: Schema.Boolean,
})
export type ComponentForm = typeof ComponentForm.Type

export const emptyComponentForm: ComponentForm = {
	editingId: null,
	name: "",
	description: "",
	group: "",
	monitorId: "",
	manualStatus: "",
	showUptime: true,
}

export const componentFormOf = (component: V2StatusPageComponent): ComponentForm => ({
	editingId: component.id,
	name: component.name,
	description: component.description ?? "",
	group: component.group ?? "",
	monitorId: component.monitor_id ?? "",
	manualStatus: component.manual_status ?? "",
	showUptime: component.show_uptime,
})

const orNull = (value: string): string | null => (value.trim() === "" ? null : value.trim())
const decodeMonitorId = Schema.decodeUnknownOption(UptimeMonitorId)
const decodeComponentStatus = Schema.decodeUnknownOption(StatusPageComponentStatus)

/** The whole component, sent on create and update alike so a cleared field is cleared. */
export const componentPayload = (form: ComponentForm): V2StatusPageComponentCreateParams => ({
	name: form.name.trim(),
	description: orNull(form.description),
	group: orNull(form.group),
	monitor_id: Option.getOrNull(decodeMonitorId(form.monitorId)),
	manual_status: Option.getOrNull(decodeComponentStatus(form.manualStatus)),
	show_uptime: form.showUptime,
})

// INCIDENTS

export const IncidentTextField = Schema.Literals([
	"title",
	"impact",
	"status",
	"body",
	"scheduledStart",
	"scheduledEnd",
])
export type IncidentTextField = typeof IncidentTextField.Type

export const IncidentForm = Schema.Struct({
	kind: StatusPageIncidentKind,
	title: Schema.String,
	impact: StatusPageIncidentImpact,
	status: StatusPageIncidentStatus,
	componentIds: Schema.Array(StatusPageComponentId),
	body: Schema.String,
	/** `false` saves a draft visitors do not see. */
	isPublished: Schema.Boolean,
	/** Maintenance only: the window as `datetime-local` values, in the viewer's time zone. */
	scheduledStart: Schema.String,
	scheduledEnd: Schema.String,
})
export type IncidentForm = typeof IncidentForm.Type

export const emptyIncidentForm = (kind: StatusPageIncidentKind): IncidentForm => ({
	kind,
	title: "",
	impact: kind === "incident" ? "minor" : "none",
	status: kind === "incident" ? "investigating" : "scheduled",
	componentIds: [],
	body: "",
	isPublished: true,
	scheduledStart: "",
	scheduledEnd: "",
})

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u

/** A `datetime-local` value read as wall-clock time in `timeZone`, as an ISO instant. */
export const localToIso = (value: string, timeZone: string): Option.Option<string> => {
	const match = LOCAL_DATE_TIME.exec(value)
	if (match === null) return Option.none()
	const [year, month, day, hour, minute] = match.slice(1).map(Number)
	return Option.map(
		DateTime.makeZoned({ year, month, day, hour, minute }, { timeZone, adjustForTimeZone: true }),
		DateTime.formatIso,
	)
}

/** What stops the incident from being sent, in reading order; empty when it can go. */
export const incidentIssues = (form: IncidentForm, timeZone: string): ReadonlyArray<string> => {
	const start = localToIso(form.scheduledStart, timeZone)
	const end = localToIso(form.scheduledEnd, timeZone)
	const windowIssue =
		form.kind !== "maintenance"
			? null
			: Option.isNone(start) || Option.isNone(end)
				? "Set when the maintenance starts and ends."
				: start.value >= end.value
					? "The maintenance must end after it starts."
					: null
	return [
		...(form.title.trim() === "" ? ["Add a title."] : []),
		...(form.body.trim() === "" ? ["Write the first update."] : []),
		...(windowIssue === null ? [] : [windowIssue]),
	]
}

export const incidentPayload = (
	form: IncidentForm,
	pageId: V2StatusPage["id"],
	timeZone: string,
): V2StatusPageIncidentCreateParams => {
	const base: V2StatusPageIncidentCreateParams = {
		page_id: pageId,
		kind: form.kind,
		title: form.title.trim(),
		impact: form.impact,
		status: form.status,
		body: form.body.trim(),
		component_ids: form.componentIds,
		published: form.isPublished,
	}
	if (form.kind !== "maintenance") return base
	return Option.match(
		Option.all([localToIso(form.scheduledStart, timeZone), localToIso(form.scheduledEnd, timeZone)]),
		{
			onNone: () => base,
			onSome: ([start, end]) => ({ ...base, scheduled_start: start, scheduled_end: end }),
		},
	)
}

// UPDATES

export const UpdateForm = Schema.Struct({
	incidentId: StatusPageIncidentId,
	kind: StatusPageIncidentKind,
	status: StatusPageIncidentStatus,
	body: Schema.String,
})
export type UpdateForm = typeof UpdateForm.Type

/** The next status along, or the closing one for Resolve. */
export const updateFormFor = (
	incident: {
		readonly id: StatusPageIncidentId
		readonly kind: StatusPageIncidentKind
		readonly status: StatusPageIncidentStatus
	},
	isResolving: boolean,
): UpdateForm => {
	const statuses: ReadonlyArray<StatusPageIncidentStatus> = STATUSES_OF_KIND[incident.kind]
	const next = statuses[statuses.indexOf(incident.status) + 1] ?? incident.status
	const status = isResolving ? closingStatus(incident.kind) : next
	return {
		incidentId: incident.id,
		kind: incident.kind,
		status,
		body: isResolving
			? incident.kind === "incident"
				? "This incident has been resolved."
				: "The maintenance is complete."
			: "",
	}
}

// SETTINGS

export const SettingsTextField = Schema.Literals([
	"name",
	"slug",
	"description",
	"websiteUrl",
	"privacyUrl",
	"termsUrl",
	"logoUrl",
	"autoIncidents",
])
export type SettingsTextField = typeof SettingsTextField.Type

/** The theme's colour inputs, as typed; blank means the preset's colour. */
export const ThemeColorField = Schema.Literals(["accent", "background", "text", "card", "border"])
export type ThemeColorField = typeof ThemeColorField.Type

/** The colours Auto ignores: they apply only to a forced Light or Dark page. */
export const THEME_OVERRIDE_FIELDS = ["background", "text", "card", "border"] as const

export const ThemeForm = Schema.Struct({
	preset: StatusPageThemePreset,
	appearance: StatusPageThemeAppearance,
	accent: Schema.String,
	background: Schema.String,
	text: Schema.String,
	card: Schema.String,
	border: Schema.String,
	radius: StatusPageThemeRadius,
	font: StatusPageThemeFont,
})
export type ThemeForm = typeof ThemeForm.Type

export const SettingsForm = Schema.Struct({
	name: Schema.String,
	slug: Schema.String,
	description: Schema.String,
	websiteUrl: Schema.String,
	privacyUrl: Schema.String,
	termsUrl: Schema.String,
	logoUrl: Schema.String,
	showPoweredBy: Schema.Boolean,
	autoIncidents: StatusPageAutoIncidents,
	theme: ThemeForm,
})
export type SettingsForm = typeof SettingsForm.Type

export const themeFormOf = (theme: StatusPageTheme): ThemeForm => ({
	...theme,
	accent: theme.accent ?? "",
	background: theme.background ?? "",
	text: theme.text ?? "",
	card: theme.card ?? "",
	border: theme.border ?? "",
})

export const settingsFormOf = (page: V2StatusPage): SettingsForm => ({
	name: page.name,
	slug: page.slug,
	description: page.description ?? "",
	websiteUrl: page.website_url ?? "",
	privacyUrl: page.privacy_url ?? "",
	termsUrl: page.terms_url ?? "",
	logoUrl: page.logo_url ?? "",
	showPoweredBy: page.show_powered_by,
	autoIncidents: page.auto_incidents,
	theme: themeFormOf(page.theme),
})

const normalizedColor = (value: string): string => value.trim().toLowerCase()

/** The theme as the API stores it: blank colours null, the rest trimmed and lower-cased. */
export const themeOf = (form: ThemeForm): StatusPageTheme => ({
	...form,
	accent: orNull(normalizedColor(form.accent)),
	background: orNull(normalizedColor(form.background)),
	text: orNull(normalizedColor(form.text)),
	card: orNull(normalizedColor(form.card)),
	border: orNull(normalizedColor(form.border)),
})

/** The values the API stores: trimmed, the colours lower-cased, as `settingsPayload` sends them. */
const normalizedSettings = (form: SettingsForm): SettingsForm => ({
	...form,
	name: form.name.trim(),
	description: form.description.trim(),
	websiteUrl: form.websiteUrl.trim(),
	privacyUrl: form.privacyUrl.trim(),
	termsUrl: form.termsUrl.trim(),
	logoUrl: form.logoUrl.trim(),
	theme: themeFormOf(themeOf(form.theme)),
})

/** Same once normalized, so a saved draft whose input differed only in case or spaces settles. */
export const isSameSettings = (left: SettingsForm, right: SettingsForm): boolean =>
	sameNormalized(normalizedSettings(left), normalizedSettings(right))

const sameNormalized = (a: SettingsForm, b: SettingsForm): boolean =>
	a.name === b.name &&
	a.slug === b.slug &&
	a.description === b.description &&
	a.websiteUrl === b.websiteUrl &&
	a.privacyUrl === b.privacyUrl &&
	a.termsUrl === b.termsUrl &&
	a.logoUrl === b.logoUrl &&
	a.showPoweredBy === b.showPoweredBy &&
	a.autoIncidents === b.autoIncidents &&
	sameTheme(a.theme, b.theme)

const sameTheme = (a: ThemeForm, b: ThemeForm): boolean =>
	a.preset === b.preset &&
	a.appearance === b.appearance &&
	a.accent === b.accent &&
	a.background === b.background &&
	a.text === b.text &&
	a.card === b.card &&
	a.border === b.border &&
	a.radius === b.radius &&
	a.font === b.font
/** The service's rule: a URL `URL` can parse, over https. Checked here so Save never sends what it refuses. */
const httpsIssue = (value: string): string | null => {
	const url = value.trim()
	if (url === "") return null
	if (url.length > STATUS_PAGE_MAX_URL_LENGTH)
		return `Keep it under ${STATUS_PAGE_MAX_URL_LENGTH} characters.`
	if (!URL.canParse(url)) return "Use a valid URL, like https://acme.example."
	return new URL(url).protocol === "https:" ? null : "Use an https URL."
}

/** Each field's problem, or `null`: the API refuses the same values. */
export const settingsIssues = (form: SettingsForm): Readonly<Record<SettingsTextField, string | null>> => ({
	name: form.name.trim() === "" ? "Add a name." : null,
	slug: slugIssue(form.slug),
	description: null,
	websiteUrl: httpsIssue(form.websiteUrl),
	privacyUrl: httpsIssue(form.privacyUrl),
	termsUrl: httpsIssue(form.termsUrl),
	logoUrl: httpsIssue(form.logoUrl),
	autoIncidents: null,
})

const colorIssue = (value: string): string | null =>
	value.trim() === "" || STATUS_PAGE_HEX_COLOR_PATTERN.test(value.trim())
		? null
		: "Use a hex color like #1a2b3c."

/** Each colour input's problem, or `null`. */
export const themeColorIssues = (theme: ThemeForm): Readonly<Record<ThemeColorField, string | null>> => ({
	accent: colorIssue(theme.accent),
	background: colorIssue(theme.background),
	text: colorIssue(theme.text),
	card: colorIssue(theme.card),
	border: colorIssue(theme.border),
})

/** Unreadable text, as the API would refuse it; checked once every colour is a valid hex. */
export const themeContrastOf = (theme: ThemeForm): string | null =>
	Object.values(themeColorIssues(theme)).some((issue) => issue !== null)
		? null
		: themeContrastIssue(themeOf(theme))

export const hasSettingsIssues = (form: SettingsForm): boolean =>
	Object.values(settingsIssues(form)).some((issue) => issue !== null) ||
	Object.values(themeColorIssues(form.theme)).some((issue) => issue !== null) ||
	themeContrastOf(form.theme) !== null

export const settingsPayload = (form: SettingsForm): V2StatusPageUpdateParams => ({
	name: form.name.trim(),
	slug: form.slug,
	description: orNull(form.description),
	website_url: orNull(form.websiteUrl),
	privacy_url: orNull(form.privacyUrl),
	terms_url: orNull(form.termsUrl),
	logo_url: orNull(form.logoUrl),
	theme: themeOf(form.theme),
	show_powered_by: form.showPoweredBy,
	auto_incidents: form.autoIncidents,
})
