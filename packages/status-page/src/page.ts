import type { StatusPageComponentStatus } from "@maple/primitives"
import { Schema, Array as Arr, Record as Rec, String as Str } from "effect"
import {
	incidentComponentStatus,
	overallStatus,
	STATUS_PAGE_STALE_AFTER_MS,
	type StatusPageDayBar,
	type StatusPageFreshness,
	type StatusPagePublicSnapshot,
	type StatusPageSnapshotComponent,
	type StatusPageSnapshotIncident,
	uptimePercent,
	utcDay,
} from "@maple/domain/status-page"
import { pageHref, previewIdAttr, type RenderOptions, renderDocument, renderHeader } from "./document"
import { escapeHtml } from "@maple/strings"
import { safeUrl } from "./escape"
import { OG_CARD_HEIGHT, OG_CARD_WIDTH, statusOgAlt, statusOgCard, statusOgCardVersion } from "./og-card"
import {
	COMPONENT_STATUS_LABEL,
	DAY_STATE_LABEL,
	dayTitle,
	formatAge,
	formatDateTime,
	formatDuration,
	formatDay,
	formatPercent,
	HERO_SENTENCE,
	IMPACT_LABEL,
	INCIDENT_STATUS_LABEL,
	MONTHS,
	pageTitle,
} from "./format"
import {
	barComponents,
	type BarMark,
	barState,
	type CalendarDay,
	type CalendarEntry,
	calendarDays,
	calendarEntries,
	calendarMonthCount,
	componentMarks,
	monthCells,
	rangeLabel,
	windowCount,
	windowDays,
} from "./history"
import { chevron, MAPLE_MARK, statusIcon } from "./icons"
import { renderUpdateBody } from "./markdown"
import { DAY_STATE_LETTER, PAGE_SCRIPT } from "./script"
import { activeIncidents, groupComponents, pastIncidents, upcomingMaintenance } from "./select"
import { pageStyles } from "./styles"
import { renderSubscribeDialog, SUBSCRIBE_LINK } from "./subscribe"

const timeTag = (ms: number): string =>
	`<time datetime="${new Date(ms).toISOString()}">${formatDateTime(ms)}</time>`

const renderUpdates = (incident: StatusPageSnapshotIncident): string =>
	incident.updates.length === 0
		? ""
		: `<ol class="updates">${Arr.join(
				Arr.map(
					incident.updates,
					(update) =>
						`<li><strong>${INCIDENT_STATUS_LABEL[update.status]}</strong><div class="body">${renderUpdateBody(update.body)}</div><span class="meta">${timeTag(update.at)}</span></li>`,
				),
				"",
			)}</ol>`

const incidentMeta = (incident: StatusPageSnapshotIncident): string => {
	if (incident.kind === "maintenance" && incident.scheduledStart !== null) {
		const end = incident.scheduledEnd === null ? "" : ` to ${timeTag(incident.scheduledEnd)}`
		return `Scheduled for ${timeTag(incident.scheduledStart)}${end}`
	}
	if (incident.resolvedAt !== null) {
		return `${timeTag(incident.startedAt)} to ${timeTag(incident.resolvedAt)} (${formatDuration(incident.resolvedAt - incident.startedAt)})`
	}
	return `Started ${timeTag(incident.startedAt)}`
}

const renderIncident = (incident: StatusPageSnapshotIncident, options: RenderOptions): string => {
	const status = incident.resolvedAt === null ? incidentComponentStatus(incident) : "operational"
	return `<article class="card incident" id="incident-${escapeHtml(incident.id)}"${previewIdAttr(options, "incident", incident.id)}><h3>${statusIcon(status)}<span>${escapeHtml(incident.title)}</span></h3><div class="meta">${INCIDENT_STATUS_LABEL[incident.status]} · ${incidentMeta(incident)}</div>${renderUpdates(incident)}</article>`
}

const renderSection = (id: string, title: string, inner: string): string =>
	`<section class="list" aria-labelledby="h-${id}"><h2 id="h-${id}">${title}</h2>${inner}</section>`

/** The status band and, under it, what is going on: the active incidents, linked, or the all-clear. */
const renderHero = (
	overall: StatusPageComponentStatus,
	active: ReadonlyArray<StatusPageSnapshotIncident>,
	affected: ReadonlyArray<StatusPageSnapshotComponent>,
): string => {
	// With no incident posted, a non-operational banner names what is affected rather than "no issues".
	const body =
		active.length === 0
			? overall === "operational"
				? `<p>We're not aware of any issues affecting our systems.</p>`
				: `<p>Affected: ${Arr.join(
						Arr.map(
							affected,
							(component) =>
								`${escapeHtml(component.name)} (${COMPONENT_STATUS_LABEL[component.status]})`,
						),
						", ",
					)}. We'll post an update here.</p>`
			: `<ul>${Arr.join(
					Arr.map(
						active,
						(incident) =>
							`<li><a href="#incident-${escapeHtml(incident.id)}">${escapeHtml(incident.title)}</a></li>`,
					),
					"",
				)}</ul>`
	return `<section class="hero s-${overall}" aria-labelledby="h-hero"><div class="hero-head">${statusIcon(overall)}<h1 id="h-hero">${HERO_SENTENCE[overall]}</h1></div><div class="hero-body">${body}</div></section>`
}

/** The hero as the page's components and active incidents call it. */
const renderPageHero = (snapshot: StatusPagePublicSnapshot): string =>
	renderHero(
		overallStatus(snapshot),
		activeIncidents(snapshot),
		Arr.filter(snapshot.components, (component) => component.status !== "operational"),
	)

/** Older and newer arrows around a live label; hidden until the script can page. */
const pager = (name: "window" | "month", label: string, unit: string): string =>
	`<div class="pager"><button type="button" data-nav="${name}" data-dir="older" aria-label="Previous ${unit}" hidden>${chevron("left")}</button><span id="${name}-label" aria-live="polite">${label}</span><button type="button" data-nav="${name}" data-dir="newer" aria-label="Next ${unit}" disabled hidden>${chevron("right")}</button></div>`

/** Status icon with the status as a tooltip, and as text for screen readers after the name. */
const statusName = (name: string, status: StatusPageComponentStatus): string =>
	`<span class="name"><span class="st" title="${COMPONENT_STATUS_LABEL[status]}">${statusIcon(status)}</span><span>${escapeHtml(name)}</span><span class="sr">: ${COMPONENT_STATUS_LABEL[status]}</span></span>`

const renderBars = (days: ReadonlyArray<StatusPageDayBar>, marks: ReadonlyMap<string, BarMark>): string => {
	const first = days[0]
	const last = days.at(-1)
	const label =
		first === undefined || last === undefined
			? "Uptime"
			: `Uptime, ${formatDay(first.day)} to ${formatDay(last.day)}`
	const bars = Arr.join(
		Arr.map(days, (bar) => {
			const mark = marks.get(bar.day)
			const state = barState(bar, mark)
			return `<li class="d-${state}" data-day="${escapeHtml(bar.day)}" data-state="${state}" title="${escapeHtml(dayTitle(bar, mark?.entry))}"></li>`
		}),
		"",
	)
	return `<ol class="bars" aria-label="${label}">${bars}</ol>`
}

/** What each bar colour means, under the bars. */
const BAR_LEGEND = `<ul class="legend" aria-label="Bar colours">${Arr.join(
	Arr.map(
		["ok", "maintenance", "degraded", "down", "none"] as const,
		(state) => `<li><span class="key d-${state}"></span>${DAY_STATE_LABEL[state]}</li>`,
	),
	"",
)}</ul>`

/** What the bars need beyond the component: the incidents to mark, and the snapshot's time, where the bars end. */
interface BarContext {
	readonly entries: ReadonlyArray<CalendarEntry>
	readonly nowMs: number
}

const renderComponent = (
	component: StatusPageSnapshotComponent,
	bars: BarContext,
	options: RenderOptions,
): string => {
	const description =
		component.description === null ? "" : `<p class="desc">${escapeHtml(component.description)}</p>`
	const showsBars = component.showUptime && component.days.length > 0
	const days = showsBars ? windowDays(component.days, 0) : []
	const percent = uptimePercent(days)
	const uptime = !showsBars
		? ""
		: `<span class="uptime">${percent === null ? "No data" : `${formatPercent(percent)} uptime`}</span>`
	return `<div class="component" data-component="${escapeHtml(component.id)}"${previewIdAttr(options, "component", component.id)}><div class="row">${statusName(component.name, component.status)}${uptime}</div>${description}${showsBars ? renderBars(days, componentMarks(component.id, bars.entries, bars.nowMs)) : ""}</div>`
}

/** The System status panel; with `onlyId`, just that component under its group's head. */
const renderSystemStatus = (
	snapshot: StatusPagePublicSnapshot,
	bars: BarContext,
	options: RenderOptions,
	onlyId?: string,
): string => {
	if (snapshot.components.length === 0) return ""
	const shown = barComponents(snapshot.components)[0]
	const label = shown === undefined ? "" : rangeLabel(windowDays(shown.days, 0))
	const head = `<div class="panel-head"><h2 id="h-components">System status</h2>${shown === undefined ? "" : pager("window", label, "90 days")}</div>`
	const groups = Arr.join(
		Arr.flatMap(groupComponents(snapshot.components), (group) => {
			const shown =
				onlyId === undefined
					? group.components
					: Arr.filter(group.components, (component) => component.id === onlyId)
			// The editor edits a group's name on its components; a click on it opens the first one.
			const first = shown[0]
			if (first === undefined) return []
			const groupHead =
				group.name === null
					? ""
					: `<div class="group-head"${previewIdAttr(options, "group", first.id)}>${statusName(group.name, group.status)}</div>`
			return [
				`<div class="group">${groupHead}${Arr.join(
					Arr.map(shown, (component) => renderComponent(component, bars, options)),
					"",
				)}</div>`,
			]
		}),
		"",
	)
	return `<section class="panel" aria-labelledby="h-components">${head}${groups}${shown === undefined ? "" : BAR_LEGEND}</section>`
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

/** `Oct 18, 2026: 2 incidents`, naming maintenance apart from incidents. */
const dayLabel = (day: string, mark: CalendarDay, entries: ReadonlyArray<CalendarEntry>): string => {
	const kinds = Arr.map(mark.entries, (index) => entries[index]?.kind)
	const incidents = Arr.filter(kinds, (kind) => kind === "incident").length
	const maintenance = kinds.length - incidents
	const parts = Arr.filter(
		[
			incidents === 0 ? "" : `${incidents} ${incidents === 1 ? "incident" : "incidents"}`,
			maintenance === 0 ? "" : `${maintenance} maintenance`,
		],
		(part) => part !== "",
	)
	return `${formatDay(day)}: ${Arr.join(parts, ", ")}`
}

const renderCalendar = (
	today: string,
	days: ReadonlyMap<string, CalendarDay>,
	entries: ReadonlyArray<CalendarEntry>,
): string => {
	const [yearText, monthText = "01"] = Str.split("-")(today)
	const year = Number(yearText)
	const month = Number(monthText)
	const cells = Arr.map(monthCells(year, month), (date) => {
		if (date === 0) return "<td></td>"
		const day = `${yearText}-${monthText}-${Str.padStart(2, "0")(String(date))}`
		const current = day === today ? ` today" aria-current="date` : ""
		const mark = days.get(day)
		if (mark === undefined) return `<td><span class="day${current}">${date}</span></td>`
		const label = escapeHtml(dayLabel(day, mark, entries))
		return `<td><button type="button" class="day t-${mark.tone}${current}" data-day="${day}" aria-label="${label}" title="${label}" aria-expanded="false" aria-controls="cal-panel">${date}</button></td>`
	})
	const rows = Arr.join(
		Array.from(
			{ length: cells.length / 7 },
			(_, week) => `<tr>${Arr.join(cells.slice(week * 7, week * 7 + 7), "")}</tr>`,
		),
		"",
	)
	const head = Arr.join(
		Arr.map(WEEKDAYS, (name) => `<th scope="col" abbr="${name}">${Str.slice(0, 1)(name)}</th>`),
		"",
	)
	return `<section class="panel" aria-labelledby="h-calendar"><div class="panel-head"><h2 id="h-calendar">Calendar <small>(UTC)</small></h2>${pager("month", `${MONTHS[month - 1] ?? ""} ${year}`, "month")}</div><table class="cal"><thead><tr>${head}</tr></thead><tbody id="cal-body">${rows}</tbody></table><div class="cal-panel" id="cal-panel" role="region" aria-label="Incidents on the chosen day" hidden></div></section>`
}

/**
 * What the script pages through. Bars are `[checks, failures, downChecks]`, or 0 for no data;
 * `states` holds each day's state as a letter, decided here so the script never re-derives it;
 * `marks` maps a day's index to the entry marked on it.
 */
const pageData = (
	snapshot: StatusPagePublicSnapshot,
	today: string,
	entries: ReadonlyArray<CalendarEntry>,
	days: ReadonlyMap<string, CalendarDay>,
) => {
	const withBars = barComponents(snapshot.components)
	const withMarks = Arr.map(withBars, (component) => ({
		component,
		marks: componentMarks(component.id, entries, snapshot.generatedAt),
	}))
	const longest = Arr.reduce<StatusPageSnapshotComponent, StatusPageSnapshotComponent | undefined>(
		withBars,
		undefined,
		(best, component) =>
			best === undefined || component.days.length > best.days.length ? component : best,
	)
	return {
		end: longest?.days.at(-1)?.day ?? today,
		len: longest?.days.length ?? 0,
		windows: windowCount(snapshot.components, entries, snapshot.generatedAt),
		bars: Rec.fromEntries(
			Arr.map(withBars, (component) => [
				component.id,
				Arr.map(component.days, (bar) =>
					bar.checks === 0 ? 0 : [bar.checks, bar.failures, bar.downChecks],
				),
			]),
		),
		states: Rec.fromEntries(
			Arr.map(withMarks, ({ component, marks }) => [
				component.id,
				Arr.join(
					Arr.map(component.days, (bar) => DAY_STATE_LETTER[barState(bar, marks.get(bar.day))]),
					"",
				),
			]),
		),
		marks: Rec.fromEntries(
			Arr.map(withMarks, ({ component, marks }) => [
				component.id,
				Rec.fromEntries(
					Arr.flatMap(component.days, (bar, index) => {
						const mark = marks.get(bar.day)
						return mark === undefined
							? []
							: [[String(index), entries.indexOf(mark.entry)] as const]
					}),
				),
			]),
		),
		today,
		months: calendarMonthCount(today),
		entries: Arr.map(entries, (entry) => ({
			title: entry.title,
			tone: entry.tone,
			meta: `${entry.kind === "maintenance" ? "Maintenance" : IMPACT_LABEL[entry.impact]} · ${entry.status}`,
			href: entry.listed ? `#incident-${entry.id}` : null,
		})),
		days: Rec.fromEntries(
			Arr.map([...days], ([day, mark]) => [
				day,
				[mark.tone, mark.entries, dayLabel(day, mark, entries)],
			]),
		),
	}
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** JSON safe inside a `<script>` element: nothing in it can close the element or open a comment. */
const scriptJson = (value: ReturnType<typeof pageData>): string =>
	Str.replaceAll(
		" ",
		"\\u2029",
	)(
		Str.replaceAll(
			" ",
			"\\u2028",
		)(
			Str.replaceAll(
				"&",
				"\\u0026",
			)(Str.replaceAll(">", "\\u003e")(Str.replaceAll("<", "\\u003c")(encodeJson(value)))),
		),
	)

const renderFooter = (
	snapshot: StatusPagePublicSnapshot,
	freshness: StatusPageFreshness,
	nowMs: number,
	options: RenderOptions,
): string => {
	const privacy = safeUrl(snapshot.page.privacyUrl, ["https:"])
	const terms = safeUrl(snapshot.page.termsUrl, ["https:"])
	// Feed readers cannot enter a password or sign in, so only a public page offers its feed.
	const links = Arr.filter(
		[
			snapshot.page.visibility === "public"
				? `<a href="${pageHref(options, "/feed.atom")}">Atom feed</a>`
				: "",
			privacy === null
				? ""
				: `<a href="${escapeHtml(privacy)}" rel="noopener"${previewIdAttr(options, "field", "privacyUrl")}>Privacy policy</a>`,
			terms === null
				? ""
				: `<a href="${escapeHtml(terms)}" rel="noopener"${previewIdAttr(options, "field", "termsUrl")}>Terms of service</a>`,
		],
		(link) => link !== "",
	)
	const powered = snapshot.page.showPoweredBy
		? `<p class="powered"${previewIdAttr(options, "field", "showPoweredBy")}>Powered by <a href="https://maple.dev" rel="noopener">${MAPLE_MARK}Maple</a></p>`
		: ""
	return `<footer>${powered}<p class="links">${Arr.join(links, " · ")}</p><p id="updated">Updated ${formatAge(nowMs - freshness.updatedAt)}</p></footer>`
}

/** `We're experiencing a partial outage. Active incident: API errors.` */
const statusSummary = (
	overall: StatusPageComponentStatus,
	active: ReadonlyArray<StatusPageSnapshotIncident>,
): string =>
	active.length === 0
		? `${HERO_SENTENCE[overall]}.`
		: `${HERO_SENTENCE[overall]}. ${active.length === 1 ? "Active incident" : "Active incidents"}: ${Arr.join(
				Arr.map(active, (incident) => incident.title),
				", ",
			)}.`

/** Where the social preview lives, relative to the page. */
export const OG_IMAGE_PATH = "/og.png"

/**
 * Link previews (Open Graph and Twitter) and the canonical address, both from `publicUrl`. The
 * image is the drawn card; its `?v=` changes with anything drawn on it, so a chat app that caches
 * previews by URL fetches the new state.
 */
const shareTags = (
	snapshot: StatusPagePublicSnapshot,
	freshness: StatusPageFreshness,
	title: string,
	summary: string,
	options: RenderOptions,
): string => {
	const url = options.publicUrl === undefined ? null : safeUrl(`${options.publicUrl}/`, ["https:", "http:"])
	const card = statusOgCard(snapshot, freshness, url === null ? null : new URL(url).host)
	// A copy with no public address cannot link its card, so it shows the logo, as before cards.
	const drawn =
		options.publicUrl === undefined
			? null
			: safeUrl(`${options.publicUrl}${OG_IMAGE_PATH}?v=${statusOgCardVersion(card)}`, [
					"https:",
					"http:",
				])
	const image =
		drawn ?? safeUrl(snapshot.page.logoUrl, ["https:"]) ?? safeUrl(snapshot.page.logoDarkUrl, ["https:"])
	const meta = (attr: "property" | "name", key: string, value: string) =>
		`<meta ${attr}="${key}" content="${escapeHtml(value)}">`
	const imageTags =
		drawn === null
			? image === null
				? []
				: [meta("property", "og:image", image), meta("name", "twitter:image", image)]
			: [
					meta("property", "og:image", drawn),
					meta("property", "og:image:type", "image/png"),
					meta("property", "og:image:width", String(OG_CARD_WIDTH)),
					meta("property", "og:image:height", String(OG_CARD_HEIGHT)),
					meta("property", "og:image:alt", statusOgAlt(card)),
					meta("name", "twitter:image", drawn),
				]
	return Arr.join(
		[
			url === null ? "" : `<link rel="canonical" href="${escapeHtml(url)}">`,
			meta("property", "og:type", "website"),
			meta("property", "og:site_name", snapshot.page.name),
			meta("property", "og:title", title),
			meta("property", "og:description", summary),
			url === null ? "" : meta("property", "og:url", url),
			meta("name", "twitter:card", drawn === null ? "summary" : "summary_large_image"),
			meta("name", "twitter:title", title),
			meta("name", "twitter:description", summary),
			...imageTags,
		],
		"",
	)
}

/** The public status page: server-rendered, self-contained, readable with scripts off. */
export const renderPage = (
	snapshot: StatusPagePublicSnapshot,
	freshness: StatusPageFreshness,
	nowMs: number,
	options: RenderOptions = {},
): string => {
	const overall = overallStatus(snapshot)
	const active = activeIncidents(snapshot)
	const upcoming = upcomingMaintenance(snapshot)
	const past = pastIncidents(snapshot)
	const delayed = freshness._tag === "delayed"
	const today = utcDay(nowMs)
	const entries = calendarEntries(snapshot)
	const days = calendarDays(entries, nowMs)
	// A page behind a password or sign-in has no feeds to subscribe to and stays out of search.
	const isPublic = snapshot.page.visibility === "public"

	const body = Arr.join(
		[
			renderHeader(snapshot, options, isPublic ? SUBSCRIBE_LINK : ""),
			isPublic ? renderSubscribeDialog(options) : "",
			options.inDashboard === true
				? ""
				: `<div class="notice" id="delayed" role="status"${delayed ? "" : " hidden"}>Live checks are delayed. Showing the last known state from ${timeTag(freshness.updatedAt)}.</div>`,
			renderPageHero(snapshot),
			active.length === 0
				? ""
				: renderSection(
						"active",
						"Active incidents",
						Arr.join(
							Arr.map(active, (incident) => renderIncident(incident, options)),
							"",
						),
					),
			upcoming.length === 0
				? ""
				: renderSection(
						"upcoming",
						"Upcoming maintenance",
						Arr.join(
							Arr.map(upcoming, (incident) => renderIncident(incident, options)),
							"",
						),
					),
			renderSystemStatus(snapshot, { entries, nowMs: snapshot.generatedAt }, options),
			renderCalendar(today, days, entries),
			renderSection(
				"past",
				"Past incidents",
				past.length === 0
					? `<p class="empty">No incidents reported recently.</p>`
					: Arr.join(
							Arr.map(past, (incident) => renderIncident(incident, options)),
							"",
						),
			),
			renderFooter(snapshot, freshness, nowMs, options),
			`<script type="application/json" id="sp-data">${scriptJson(pageData(snapshot, today, entries, days))}</script>`,
		],
		"",
	)

	const title = pageTitle(snapshot.page.name)
	const summary = statusSummary(overall, active)
	return renderDocument({
		snapshot,
		options,
		title,
		description: snapshot.page.description ?? summary,
		styles: pageStyles,
		body,
		bodyAttrs: ` data-generated-at="${snapshot.generatedAt}" data-updated-at="${freshness.updatedAt}" data-stale-after="${STATUS_PAGE_STALE_AFTER_MS}" data-freshness="${freshness._tag}"`,
		// Share tags would show a non-public page's status in link previews.
		head: isPublic
			? `${shareTags(snapshot, freshness, title, summary, options)}<link rel="alternate" type="application/atom+xml" title="${escapeHtml(snapshot.page.name)} status" href="${pageHref(options, "/feed.atom")}"><link rel="alternate" type="application/rss+xml" title="${escapeHtml(snapshot.page.name)} status" href="${pageHref(options, "/feed.rss")}">`
			: `<meta name="robots" content="noindex">`,
		script: PAGE_SCRIPT,
	})
}
