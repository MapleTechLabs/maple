import {
	StatusPageComponentStatus,
	type StatusPageIncidentImpact,
	type StatusPageIncidentKind,
	type StatusPageIncidentStatus,
} from "@maple/domain"
import {
	V2StatusPage,
	type V2StatusPageComponent,
	type V2StatusPageIncident,
	type V2UptimeMonitor,
} from "@maple/domain/http/v2"
import {
	deriveComponentStatus,
	incidentComponentStatus,
	isActiveIncident,
	worstStatus,
} from "@maple/domain/status-page"
import type { Tone } from "@maple/ui/lib/tone"
import { Schema } from "effect"

// Pure reads of status pages shared by the hub's tab and the editor.

/** A hub row: the page, its components' worst status and its open incidents. */
export const StatusPageSummary = Schema.Struct({
	page: V2StatusPage,
	overall: StatusPageComponentStatus,
	componentCount: Schema.Number,
	openIncidents: Schema.Number,
})
export type StatusPageSummary = typeof StatusPageSummary.Type

export const COMPONENT_STATUS_LABEL = {
	operational: "Operational",
	maintenance: "Maintenance",
	degraded: "Degraded",
	partial_outage: "Partial outage",
	major_outage: "Major outage",
} as const satisfies Record<StatusPageComponentStatus, string>

/** The statuses a component can be set to by hand, best first. */
export const COMPONENT_STATUS_OPTIONS: ReadonlyArray<StatusPageComponentStatus> = [
	"operational",
	"degraded",
	"partial_outage",
	"major_outage",
	"maintenance",
]

export const COMPONENT_STATUS_TONE = {
	operational: "ok",
	maintenance: "info",
	degraded: "warn",
	partial_outage: "warn",
	major_outage: "crit",
} as const satisfies Record<StatusPageComponentStatus, Tone>

export const IMPACT_LABEL = {
	none: "None",
	minor: "Minor",
	major: "Major",
	critical: "Critical",
} as const satisfies Record<StatusPageIncidentImpact, string>

export const INCIDENT_STATUS_LABEL = {
	investigating: "Investigating",
	identified: "Identified",
	monitoring: "Monitoring",
	resolved: "Resolved",
	scheduled: "Scheduled",
	in_progress: "In progress",
	completed: "Completed",
} as const satisfies Record<StatusPageIncidentStatus, string>

/** The statuses an incident or a maintenance moves through, the closing one last. */
export const STATUSES_OF_KIND = {
	incident: ["investigating", "identified", "monitoring", "resolved"],
	maintenance: ["scheduled", "in_progress", "completed"],
} as const satisfies Record<StatusPageIncidentKind, ReadonlyArray<StatusPageIncidentStatus>>

export const closingStatus = (kind: StatusPageIncidentKind): StatusPageIncidentStatus =>
	kind === "incident" ? "resolved" : "completed"

/** Not yet resolved or completed. */
export const isOpenIncident = (incident: V2StatusPageIncident): boolean =>
	incident.status !== "resolved" && incident.status !== "completed"

/** What a visitor sees for one component: monitor, override and published active incidents. */
export const componentStatus = (
	component: V2StatusPageComponent,
	monitors: ReadonlyArray<V2UptimeMonitor>,
	incidents: ReadonlyArray<V2StatusPageIncident>,
): StatusPageComponentStatus =>
	deriveComponentStatus({
		monitorStatus: monitors.find((monitor) => monitor.id === component.monitor_id)?.state.status ?? null,
		manualStatus: component.manual_status,
		incidentStatuses: incidents
			.filter(
				(incident) =>
					incident.published &&
					isActiveIncident(incident) &&
					incident.component_ids.includes(component.id),
			)
			.map(incidentComponentStatus),
	})

export const summarizePage = (input: {
	readonly page: V2StatusPage
	readonly components: ReadonlyArray<V2StatusPageComponent>
	readonly incidents: ReadonlyArray<V2StatusPageIncident>
	readonly monitors: ReadonlyArray<V2UptimeMonitor>
}): StatusPageSummary => ({
	page: input.page,
	overall: worstStatus(
		input.components.map((component) => componentStatus(component, input.monitors, input.incidents)),
	),
	componentCount: input.components.length,
	openIncidents: input.incidents.filter(isOpenIncident).length,
})

/** Whether visitors see an older revision than the page has now. */
export const hasUnpublishedChanges = (page: V2StatusPage): boolean => page.published_revision < page.revision
