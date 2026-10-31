import {
	dayState,
	incidentComponentStatus,
	overallStatus,
	STATUS_PAGE_STALE_AFTER_MS,
	type StatusPageFreshness,
	type StatusPageSnapshot,
	type StatusPageSnapshotComponent,
	type StatusPageSnapshotIncident,
	uptimePercent,
} from "@maple/domain/status-page"
import { pageHref, type RenderOptions, renderDocument, renderHeader } from "./document"
import { escapeHtml } from "./escape"
import {
	COMPONENT_STATUS_LABEL,
	dayTitle,
	formatAge,
	formatDateTime,
	INCIDENT_STATUS_LABEL,
	OVERALL_STATUS_LABEL,
	formatPercent,
} from "./format"
import { activeIncidents, groupComponents, pastIncidents, upcomingMaintenance } from "./select"
import { pageStyles } from "./styles"

/** Recomputes "Updated ..." and reveals the delayed banner, so a cached copy ages honestly. */
export const PAGE_SCRIPT = `(function(){var b=document.body,u=+b.getAttribute("data-updated-at"),s=+b.getAttribute("data-stale-after");function a(ms){var m=Math.floor(Math.max(0,ms)/6e4);if(m<1)return"just now";if(m<60)return m+" min ago";var h=Math.floor(m/60);return h<48?h+" h ago":Math.floor(h/24)+" d ago"}function t(){var g=Date.now()-u,e=document.getElementById("updated"),d=document.getElementById("delayed");if(e)e.textContent="Updated "+a(g);if(d&&g>s)d.hidden=false}t();setInterval(t,3e4)})();`

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

const renderIncident = (incident: StatusPageSnapshotIncident, withUpdates: boolean): string =>
	`<article class="card s-${incident.resolvedAt === null ? incidentComponentStatus(incident) : "operational"}" id="incident-${escapeHtml(incident.id)}"><h3><span class="dot"></span>${escapeHtml(incident.title)}</h3><div class="meta">${INCIDENT_STATUS_LABEL[incident.status]} · ${incidentMeta(incident)}</div>${withUpdates ? renderUpdates(incident) : ""}</article>`

const renderBars = (component: StatusPageSnapshotComponent): string => {
	if (!component.showUptime || component.days.length === 0) return ""
	const percent = uptimePercent(component.days)
	const bars = component.days
		.map((bar) => {
			const state = dayState(bar)
			return `<li class="d-${state}" data-day="${escapeHtml(bar.day)}" data-state="${state}" title="${escapeHtml(dayTitle(bar, state))}"></li>`
		})
		.join("")
	const uptime = percent === null ? "No checks yet" : `${formatPercent(percent)} uptime`
	return `<ol class="bars" aria-label="Uptime, last ${component.days.length} days">${bars}</ol><div class="bar-foot"><span>${component.days.length} days ago</span><span class="uptime">${uptime}</span><span>Today</span></div>`
}

const renderComponent = (component: StatusPageSnapshotComponent): string => {
	const description =
		component.description === null ? "" : `<p class="desc">${escapeHtml(component.description)}</p>`
	return `<div class="component s-${component.status}" data-component="${escapeHtml(component.id)}"><div class="row"><span class="name">${escapeHtml(component.name)}</span><span class="status">${COMPONENT_STATUS_LABEL[component.status]}</span></div>${description}${renderBars(component)}</div>`
}

const renderComponents = (snapshot: StatusPageSnapshot): string => {
	if (snapshot.components.length === 0) return ""
	const groups = groupComponents(snapshot.components)
		.map((group) => {
			const head =
				group.name === null
					? ""
					: `<div class="group-head s-${group.status}"><span>${escapeHtml(group.name)}</span><span class="status">${COMPONENT_STATUS_LABEL[group.status]}</span></div>`
			return `<div class="group">${head}${group.components.map(renderComponent).join("")}</div>`
		})
		.join("")
	return `<section aria-labelledby="h-components"><h2 id="h-components">Components</h2><div class="components">${groups}</div></section>`
}

const renderSection = (id: string, title: string, inner: string): string =>
	`<section aria-labelledby="h-${id}"><h2 id="h-${id}">${title}</h2>${inner}</section>`

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

	const body = [
		renderHeader(snapshot, options),
		`<div class="notice" id="delayed" role="status"${delayed ? "" : " hidden"}>Live checks are delayed. Showing the last known state from ${timeTag(freshness.updatedAt)}.</div>`,
		`<div class="banner s-${overall}"><span class="dot"></span><h1>${OVERALL_STATUS_LABEL[overall]}</h1></div>`,
		active.length === 0
			? ""
			: renderSection(
					"active",
					"Active incidents",
					active.map((i) => renderIncident(i, true)).join(""),
				),
		upcoming.length === 0
			? ""
			: renderSection(
					"upcoming",
					"Upcoming maintenance",
					upcoming.map((i) => renderIncident(i, true)).join(""),
				),
		renderComponents(snapshot),
		renderSection(
			"past",
			"Past incidents",
			past.length === 0
				? `<p class="empty">No incidents reported recently.</p>`
				: past.map((i) => renderIncident(i, true)).join(""),
		),
		`<footer><span id="updated">Updated ${formatAge(nowMs - freshness.updatedAt)}</span><span><a href="${pageHref(options, "/feed.atom")}">Atom feed</a>${snapshot.page.showPoweredBy ? ` · Powered by <a href="https://maple.dev" rel="noopener">Maple</a>` : ""}</span></footer>`,
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
