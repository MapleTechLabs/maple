import type { StatusPageComponentStatus } from "@maple/domain/primitives"
import {
	overallStatus,
	type StatusPageFreshness,
	type StatusPageSnapshot,
	type StatusPageSnapshotIncident,
} from "@maple/domain/status-page"
import { activeIncidents } from "./select"

/** statuspage.io's page indicator for the overall status. */
export const STATUS_INDICATOR = {
	operational: { indicator: "none", description: "All Systems Operational" },
	maintenance: { indicator: "maintenance", description: "Service Under Maintenance" },
	degraded: { indicator: "minor", description: "Partially Degraded Service" },
	partial_outage: { indicator: "major", description: "Partial System Outage" },
	major_outage: { indicator: "critical", description: "Major System Outage" },
} as const satisfies Record<StatusPageComponentStatus, { indicator: string; description: string }>

const COMPONENT_STATUS = {
	operational: "operational",
	maintenance: "under_maintenance",
	degraded: "degraded_performance",
	partial_outage: "partial_outage",
	major_outage: "major_outage",
} as const satisfies Record<StatusPageComponentStatus, string>

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString())

const incidentJson = (incident: StatusPageSnapshotIncident) => ({
	id: incident.id,
	name: incident.title,
	status: incident.status,
	impact: incident.impact,
	created_at: iso(incident.startedAt),
	updated_at: iso(incident.updates[0]?.at ?? incident.startedAt),
	resolved_at: iso(incident.resolvedAt),
	component_ids: incident.componentIds,
	incident_updates: incident.updates.map((update) => ({
		id: update.id,
		status: update.status,
		body: update.body,
		created_at: iso(update.at),
	})),
})

/** A statuspage.io-style `summary.json`, plus whether live checks are delayed. */
export const renderStatusJson = (snapshot: StatusPageSnapshot, freshness: StatusPageFreshness) => {
	const overall = overallStatus(snapshot)
	const active = activeIncidents(snapshot)
	return {
		page: {
			id: snapshot.pageId,
			name: snapshot.page.name,
			url: snapshot.page.websiteUrl,
			time_zone: "Etc/UTC",
			updated_at: iso(freshness.updatedAt),
		},
		status: { ...STATUS_INDICATOR[overall], delayed: freshness._tag === "delayed" },
		components: snapshot.components.map((component) => ({
			id: component.id,
			name: component.name,
			description: component.description,
			group: component.group,
			status: COMPONENT_STATUS[component.status],
		})),
		incidents: active.filter((incident) => incident.kind === "incident").map(incidentJson),
		scheduled_maintenances: snapshot.incidents
			.filter((incident) => incident.kind === "maintenance" && incident.status !== "completed")
			.map((incident) => ({
				...incidentJson(incident),
				scheduled_for: iso(incident.scheduledStart),
				scheduled_until: iso(incident.scheduledEnd),
			})),
		updated_at: iso(freshness.updatedAt),
	}
}
