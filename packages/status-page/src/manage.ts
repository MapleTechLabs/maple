import { StatusPageIncidentImpact, StatusPageIncidentStatus } from "@maple/domain/primitives"
import type { StatusPageSnapshot } from "@maple/domain/status-page"
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

export interface ManageMessage {
	readonly tone: "ok" | "error"
	readonly text: string
}

const option = (value: string, label: string): string =>
	`<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`

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
		`<label>Incident<select name="${f.incidentId}">${option(NEW_INCIDENT, "New incident")}${incidents.map((incident) => option(incident.id, incident.title)).join("")}</select></label>`,
		`<label>Title (new incidents)<input type="text" name="${f.title}" maxlength="200"></label>`,
		`<label>Status<select name="${f.status}">${StatusPageIncidentStatus.literals.map((status) => option(status, INCIDENT_STATUS_LABEL[status])).join("")}</select></label>`,
		`<label>Impact<select name="${f.impact}">${StatusPageIncidentImpact.literals.map((impact) => option(impact, IMPACT_LABEL[impact])).join("")}</select></label>`,
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
	})
}
