import {
	StatusPageIncidentImpact,
	type StatusPageIncidentKind,
	StatusPageIncidentStatus,
} from "@maple/domain/primitives"
import { type StatusPageSnapshot, statusFitsKind } from "@maple/domain/status-page"
import { pageHref, type RenderOptions, renderDocument, renderHeader } from "./document"
import { escapeHtml } from "./escape"
import { IMPACT_LABEL, INCIDENT_STATUS_LABEL } from "./format"
import { activeIncidents, upcomingMaintenance } from "./select"
import { manageStyles } from "./styles"

/** Form field names, shared with the Worker that parses the POST. */
export const MANAGE_FIELDS = {
	token: "token",
	incidentId: "incidentId",
	title: "title",
	status: "status",
	impact: "impact",
	componentIds: "componentIds",
	body: "body",
} as const

/** `incidentId` value that opens a new incident. */
export const NEW_INCIDENT = "new"

/** Status and impact value that keeps the incident's current one; a new incident takes the defaults. */
export const NO_CHANGE = ""

export interface ManageMessage {
	readonly tone: "ok" | "error"
	readonly text: string
}

const option = (value: string, label: string, selected = false): string =>
	`<option value="${escapeHtml(value)}"${selected ? " selected" : ""}>${escapeHtml(label)}</option>`

/** A target option carrying its kind, so the status select can follow it. */
const targetOption = (value: string, label: string, kind: StatusPageIncidentKind): string =>
	`<option value="${escapeHtml(value)}" data-kind="${kind}">${escapeHtml(label)}</option>`

/**
 * Disables the status group the chosen target cannot take, and clears a choice from it. Without
 * script the server still answers a mismatch with a 400 that names the right group.
 */
const followTargetKind = (targetField: string, statusField: string): string =>
	`(()=>{const t=document.querySelector('select[name="${targetField}"]'),s=document.querySelector('select[name="${statusField}"]');if(!t||!s)return;const sync=()=>{const k=t.selectedOptions[0]?.dataset.kind??"incident";s.querySelectorAll("optgroup").forEach((g)=>{g.disabled=g.dataset.kind!==k});if(s.selectedOptions[0]?.parentElement?.disabled)s.value=""};t.addEventListener("change",sync);sync()})()`

/** Statuses grouped by lifecycle: posting one to the other kind is rejected, so the form says which is which. */
const statusGroup = (kind: StatusPageIncidentKind, label: string): string =>
	`<optgroup label="${label}" data-kind="${kind}">${StatusPageIncidentStatus.literals
		.filter((status) => statusFitsKind(kind, status))
		.map((status) => option(status, INCIDENT_STATUS_LABEL[status]))
		.join("")}</optgroup>`

/** Break-glass form: post an incident update straight to the edge while Maple is down. */
export const renderManagePage = (
	snapshot: StatusPageSnapshot,
	message?: ManageMessage,
	options: RenderOptions = {},
): string => {
	const f = MANAGE_FIELDS
	const incidents = [...activeIncidents(snapshot), ...upcomingMaintenance(snapshot)]
	const notice =
		message === undefined
			? ""
			: `<div class="notice${message.tone === "ok" ? " ok" : ""}" role="status">${escapeHtml(message.text)}</div>`
	const components =
		snapshot.components.length === 0
			? ""
			: `<fieldset><legend>Affected components</legend>${snapshot.components
					.map(
						(component) =>
							`<label class="check"><input type="checkbox" name="${f.componentIds}" value="${escapeHtml(component.id)}">${escapeHtml(component.name)}</label>`,
					)
					.join("")}</fieldset>`
	const body = [
		renderHeader(snapshot, options),
		notice,
		`<section><h2>Post an update</h2><p class="meta">For use while Maple is unreachable. The update shows on the page at once and is imported into Maple when it recovers.</p>`,
		`<form method="post" action="${pageHref(options, "/_manage")}" class="card">`,
		`<label>Break-glass token<input type="password" name="${f.token}" autocomplete="off" required></label>`,
		`<label>Incident<select name="${f.incidentId}">${targetOption(NEW_INCIDENT, "New incident", "incident")}${incidents.map((incident) => targetOption(incident.id, incident.kind === "maintenance" ? `Maintenance: ${incident.title}` : incident.title, incident.kind)).join("")}</select></label>`,
		`<label>Title (new incidents)<input type="text" name="${f.title}" maxlength="200"></label>`,
		`<label>Status<select name="${f.status}">${option(NO_CHANGE, "No change (new incidents: Investigating)", true)}${statusGroup("incident", "For incidents")}${statusGroup("maintenance", "For maintenance")}</select></label>`,
		`<label>Impact<select name="${f.impact}">${option(NO_CHANGE, "No change (new incidents: Major)", true)}${StatusPageIncidentImpact.literals.map((impact) => option(impact, IMPACT_LABEL[impact])).join("")}</select></label>`,
		components,
		`<label>Message<textarea name="${f.body}" maxlength="5000" required></textarea></label>`,
		`<button type="submit">Post update</button></form></section>`,
		`<footer><a href="${pageHref(options, "/")}">Back to the status page</a></footer>`,
	].join("")
	return renderDocument({
		snapshot,
		options,
		title: `Post an update: ${snapshot.page.name}`,
		styles: manageStyles,
		body,
		head: `<meta name="robots" content="noindex">`,
		script: followTargetKind(f.incidentId, f.status),
	})
}
