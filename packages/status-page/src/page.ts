import type { StatusPageComponentStatus } from "@maple/domain/primitives"
import {
	dayState,
	incidentComponentStatus,
	overallStatus,
	STATUS_PAGE_STALE_AFTER_MS,
	type StatusPageDayBar,
	type StatusPageFreshness,
	type StatusPageSnapshot,
	type StatusPageSnapshotComponent,
	type StatusPageSnapshotIncident,
	uptimePercent,
	utcDay,
} from "@maple/domain/status-page"
import { pageHref, previewIdAttr, type RenderOptions, renderDocument, renderHeader } from "./document"
import { escapeHtml, safeUrl } from "./escape"
import {
	COMPONENT_STATUS_LABEL,
	dayTitle,
	formatAge,
	formatDateTime,
	formatDay,
	formatPercent,
	HERO_SENTENCE,
	IMPACT_LABEL,
	INCIDENT_STATUS_LABEL,
	MONTHS,
} from "./format"
import {
	barComponents,
	type CalendarDay,
	type CalendarEntry,
	calendarDays,
	calendarEntries,
	calendarMonthCount,
	monthCells,
	rangeLabel,
	windowCount,
	windowDays,
} from "./history"
import { chevron, MAPLE_MARK, statusIcon } from "./icons"
import { PAGE_SCRIPT } from "./script"
import { activeIncidents, groupComponents, pastIncidents, upcomingMaintenance } from "./select"
import { pageStyles } from "./styles"

const timeTag = (ms: number): string =>
	`<time datetime="${new Date(ms).toISOString()}">${formatDateTime(ms)}</time>`

const renderUpdates = (incident: StatusPageSnapshotIncident): string =>
	incident.updates.length === 0
		? ""
		: `<ol class="updates">${incident.updates
				.map(
					(update) =>
						`<li><strong>${INCIDENT_STATUS_LABEL[update.status]}</strong><p class="body">${escapeHtml(update.body)}</p><span class="meta">${timeTag(update.at)}</span></li>`,
				)
				.join("")}</ol>`

const incidentMeta = (incident: StatusPageSnapshotIncident): string => {
	if (incident.kind === "maintenance" && incident.scheduledStart !== null) {
		const end = incident.scheduledEnd === null ? "" : ` to ${timeTag(incident.scheduledEnd)}`
		return `Scheduled for ${timeTag(incident.scheduledStart)}${end}`
	}
	if (incident.resolvedAt !== null) {
		return `${timeTag(incident.startedAt)} to ${timeTag(incident.resolvedAt)}`
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
				: `<p>Affected: ${affected.map((component) => `${escapeHtml(component.name)} (${COMPONENT_STATUS_LABEL[component.status]})`).join(", ")}. We'll post an update here.</p>`
			: `<ul>${active
					.map(
						(incident) =>
							`<li><a href="#incident-${escapeHtml(incident.id)}">${escapeHtml(incident.title)}</a></li>`,
					)
					.join("")}</ul>`
	return `<section class="hero s-${overall}" aria-labelledby="h-hero"><div class="hero-head">${statusIcon(overall)}<h1 id="h-hero">${HERO_SENTENCE[overall]}</h1></div><div class="hero-body">${body}</div></section>`
}

/** Older and newer arrows around a live label; hidden until the script can page. */
const pager = (name: "window" | "month", label: string, unit: string): string =>
	`<div class="pager"><button type="button" data-nav="${name}" data-dir="older" aria-label="Previous ${unit}" hidden>${chevron("left")}</button><span id="${name}-label" aria-live="polite">${label}</span><button type="button" data-nav="${name}" data-dir="newer" aria-label="Next ${unit}" disabled hidden>${chevron("right")}</button></div>`

/** Status icon with the status as a tooltip, and as text for screen readers after the name. */
const statusName = (name: string, status: StatusPageComponentStatus): string =>
	`<span class="name"><span class="st" title="${COMPONENT_STATUS_LABEL[status]}">${statusIcon(status)}</span><span>${escapeHtml(name)}</span><span class="sr">: ${COMPONENT_STATUS_LABEL[status]}</span></span>`

const renderBars = (days: ReadonlyArray<StatusPageDayBar>): string => {
	const first = days[0]
	const last = days.at(-1)
	const label =
		first === undefined || last === undefined
			? "Uptime"
			: `Uptime, ${formatDay(first.day)} to ${formatDay(last.day)}`
	const bars = days
		.map((bar) => {
			const state = dayState(bar)
			return `<li class="d-${state}" data-day="${escapeHtml(bar.day)}" data-state="${state}" title="${escapeHtml(dayTitle(bar, state))}"></li>`
		})
		.join("")
	return `<ol class="bars" aria-label="${label}">${bars}</ol>`
}

const renderComponent = (component: StatusPageSnapshotComponent, options: RenderOptions): string => {
	const description =
		component.description === null ? "" : `<p class="desc">${escapeHtml(component.description)}</p>`
	const showsBars = component.showUptime && component.days.length > 0
	const days = showsBars ? windowDays(component.days, 0) : []
	const percent = uptimePercent(days)
	const uptime = !showsBars
		? ""
		: `<span class="uptime">${percent === null ? "No data" : `${formatPercent(percent)} uptime`}</span>`
	return `<div class="component" data-component="${escapeHtml(component.id)}"${previewIdAttr(options, "component", component.id)}><div class="row">${statusName(component.name, component.status)}${uptime}</div>${description}${showsBars ? renderBars(days) : ""}</div>`
}

const renderSystemStatus = (snapshot: StatusPageSnapshot, options: RenderOptions): string => {
	if (snapshot.components.length === 0) return ""
	const shown = barComponents(snapshot.components)[0]
	const label = shown === undefined ? "" : rangeLabel(windowDays(shown.days, 0))
	const head = `<div class="panel-head"><h2 id="h-components">System status</h2>${shown === undefined ? "" : pager("window", label, "90 days")}</div>`
	const groups = groupComponents(snapshot.components)
		.map((group) => {
			const groupHead =
				group.name === null
					? ""
					: `<div class="group-head">${statusName(group.name, group.status)}</div>`
			return `<div class="group">${groupHead}${group.components.map((component) => renderComponent(component, options)).join("")}</div>`
		})
		.join("")
	return `<section class="panel" aria-labelledby="h-components">${head}${groups}</section>`
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

/** `Oct 18, 2026: 2 incidents`, naming maintenance apart from incidents. */
const dayLabel = (day: string, mark: CalendarDay, entries: ReadonlyArray<CalendarEntry>): string => {
	const kinds = mark.entries.map((index) => entries[index]?.kind)
	const incidents = kinds.filter((kind) => kind === "incident").length
	const maintenance = kinds.length - incidents
	const parts = [
		incidents === 0 ? "" : `${incidents} ${incidents === 1 ? "incident" : "incidents"}`,
		maintenance === 0 ? "" : `${maintenance} maintenance`,
	].filter((part) => part !== "")
	return `${formatDay(day)}: ${parts.join(", ")}`
}

const renderCalendar = (
	today: string,
	days: ReadonlyMap<string, CalendarDay>,
	entries: ReadonlyArray<CalendarEntry>,
): string => {
	const [yearText = "1970", monthText = "01"] = today.split("-")
	const year = Number(yearText)
	const month = Number(monthText)
	const cells = monthCells(year, month).map((date) => {
		if (date === 0) return "<td></td>"
		const day = `${yearText}-${monthText}-${String(date).padStart(2, "0")}`
		const current = day === today ? ` today" aria-current="date` : ""
		const mark = days.get(day)
		if (mark === undefined) return `<td><span class="day${current}">${date}</span></td>`
		const label = escapeHtml(dayLabel(day, mark, entries))
		return `<td><button type="button" class="day t-${mark.tone}${current}" data-day="${day}" aria-label="${label}" title="${label}" aria-expanded="false" aria-controls="cal-panel">${date}</button></td>`
	})
	const rows = Array.from(
		{ length: cells.length / 7 },
		(_, week) => `<tr>${cells.slice(week * 7, week * 7 + 7).join("")}</tr>`,
	).join("")
	const head = WEEKDAYS.map((name) => `<th scope="col" abbr="${name}">${name.slice(0, 1)}</th>`).join("")
	return `<section class="panel" aria-labelledby="h-calendar"><div class="panel-head"><h2 id="h-calendar">Calendar</h2>${pager("month", `${MONTHS[month - 1] ?? ""} ${year}`, "month")}</div><table class="cal"><thead><tr>${head}</tr></thead><tbody id="cal-body">${rows}</tbody></table><div class="cal-panel" id="cal-panel" role="region" aria-label="Incidents on the chosen day" hidden></div></section>`
}

/** What the script pages through. Bars are `[checks, failures, downChecks]`, or 0 for no data. */
const pageData = (
	snapshot: StatusPageSnapshot,
	today: string,
	entries: ReadonlyArray<CalendarEntry>,
	days: ReadonlyMap<string, CalendarDay>,
) => {
	const withBars = barComponents(snapshot.components)
	const longest = withBars.reduce<StatusPageSnapshotComponent | undefined>(
		(best, component) =>
			best === undefined || component.days.length > best.days.length ? component : best,
		undefined,
	)
	return {
		end: longest?.days.at(-1)?.day ?? today,
		len: longest?.days.length ?? 0,
		windows: windowCount(snapshot.components),
		bars: Object.fromEntries(
			withBars.map((component) => [
				component.id,
				component.days.map((bar) =>
					bar.checks === 0 ? 0 : [bar.checks, bar.failures, bar.downChecks],
				),
			]),
		),
		today,
		months: calendarMonthCount(today),
		entries: entries.map((entry) => ({
			title: entry.title,
			tone: entry.tone,
			meta: `${entry.kind === "maintenance" ? "Maintenance" : IMPACT_LABEL[entry.impact]} · ${entry.status}`,
			href: entry.listed ? `#incident-${entry.id}` : null,
		})),
		days: Object.fromEntries(
			[...days].map(([day, mark]) => [day, [mark.tone, mark.entries, dayLabel(day, mark, entries)]]),
		),
	}
}

/** JSON safe inside a `<script>` element: nothing in it can close the element or open a comment. */
const scriptJson = (value: ReturnType<typeof pageData>): string =>
	JSON.stringify(value)
		.replaceAll("<", "\\u003c")
		.replaceAll(">", "\\u003e")
		.replaceAll("&", "\\u0026")
		.replaceAll(" ", "\\u2028")
		.replaceAll(" ", "\\u2029")

const renderFooter = (
	snapshot: StatusPageSnapshot,
	freshness: StatusPageFreshness,
	nowMs: number,
	options: RenderOptions,
): string => {
	const privacy = safeUrl(snapshot.page.privacyUrl, ["https:"])
	const terms = safeUrl(snapshot.page.termsUrl, ["https:"])
	const links = [
		`<a href="${pageHref(options, "/feed.atom")}">Atom feed</a>`,
		privacy === null ? "" : `<a href="${escapeHtml(privacy)}" rel="noopener">Privacy policy</a>`,
		terms === null ? "" : `<a href="${escapeHtml(terms)}" rel="noopener">Terms of service</a>`,
	].filter((link) => link !== "")
	const powered = snapshot.page.showPoweredBy
		? `<p class="powered">Powered by <a href="https://maple.dev" rel="noopener">${MAPLE_MARK}Maple</a></p>`
		: ""
	return `<footer>${powered}<p class="links">${links.join(" · ")}</p><p id="updated">Updated ${formatAge(nowMs - freshness.updatedAt)}</p></footer>`
}

/** The public status page: server-rendered, self-contained, readable with scripts off. */
export const renderPage = (
	snapshot: StatusPageSnapshot,
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

	const body = [
		renderHeader(snapshot, options),
		`<div class="notice" id="delayed" role="status"${delayed ? "" : " hidden"}>Live checks are delayed. Showing the last known state from ${timeTag(freshness.updatedAt)}.</div>`,
		renderHero(
			overall,
			active,
			snapshot.components.filter((component) => component.status !== "operational"),
		),
		active.length === 0
			? ""
			: renderSection(
					"active",
					"Active incidents",
					active.map((incident) => renderIncident(incident, options)).join(""),
				),
		upcoming.length === 0
			? ""
			: renderSection(
					"upcoming",
					"Upcoming maintenance",
					upcoming.map((incident) => renderIncident(incident, options)).join(""),
				),
		renderSystemStatus(snapshot, options),
		renderCalendar(today, days, entries),
		renderSection(
			"past",
			"Past incidents",
			past.length === 0
				? `<p class="empty">No incidents reported recently.</p>`
				: past.map((incident) => renderIncident(incident, options)).join(""),
		),
		renderFooter(snapshot, freshness, nowMs, options),
		`<script type="application/json" id="sp-data">${scriptJson(pageData(snapshot, today, entries, days))}</script>`,
	].join("")

	return renderDocument({
		snapshot,
		options,
		title: `${snapshot.page.name} status`,
		styles: pageStyles,
		body,
		bodyAttrs: ` data-generated-at="${snapshot.generatedAt}" data-updated-at="${freshness.updatedAt}" data-stale-after="${STATUS_PAGE_STALE_AFTER_MS}" data-freshness="${freshness._tag}"`,
		head: `<link rel="alternate" type="application/atom+xml" title="${escapeHtml(snapshot.page.name)} status" href="${pageHref(options, "/feed.atom")}">`,
		script: PAGE_SCRIPT,
	})
}
