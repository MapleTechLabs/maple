import type {
	StatusPageComponentId,
	StatusPageComponentStatus,
	StatusPageId,
	UptimeMonitorStatus,
} from "@maple/domain/primitives"
import {
	deriveComponentStatus,
	incidentComponentStatus,
	isActiveIncident,
	lastDays,
	STATUS_PAGE_WINDOW_DAYS,
	STATUS_PAGE_SNAPSHOT_VERSION,
	type StatusPageDayBar,
	type StatusPageSnapshot,
	type StatusPageSnapshotIncident,
	type StatusPageSnapshotPage,
} from "@maple/domain/status-page"

export interface PreviewComponent {
	readonly id: StatusPageComponentId
	readonly name: string
	readonly description: string | null
	readonly group: string | null
	readonly monitorStatus: UptimeMonitorStatus | null
	readonly manualStatus: StatusPageComponentStatus | null
	readonly showUptime: boolean
	readonly monitored: boolean
	/** The monitor's real history, oldest first; one window of empty bars when absent. */
	readonly days?: ReadonlyArray<StatusPageDayBar>
}

/**
 * A snapshot of what the page would look like with the editor's draft, for the dashboard
 * preview. Monitored components show the `days` given, or one window of empty bars without
 * them. The calendar marks the incidents passed in.
 */
export const previewSnapshot = (input: {
	readonly pageId: StatusPageId
	readonly page: StatusPageSnapshotPage
	readonly components: ReadonlyArray<PreviewComponent>
	/** Published incidents only, newest first. */
	readonly incidents: ReadonlyArray<StatusPageSnapshotIncident>
	readonly nowMs: number
}): StatusPageSnapshot => {
	const active = input.incidents.filter(isActiveIncident)
	const emptyDays = lastDays(input.nowMs, STATUS_PAGE_WINDOW_DAYS).map((day) => ({
		day,
		checks: 0,
		failures: 0,
		downChecks: 0,
	}))
	return {
		schemaVersion: STATUS_PAGE_SNAPSHOT_VERSION,
		pageId: input.pageId,
		revision: 0,
		generatedAt: input.nowMs,
		page: input.page,
		breakGlassTokenSha256: null,
		components: input.components.map((component) => {
			const baseStatus = deriveComponentStatus({
				monitorStatus: component.monitorStatus,
				manualStatus: component.manualStatus,
				incidentStatuses: [],
			})
			return {
				id: component.id,
				name: component.name,
				description: component.description,
				group: component.group,
				baseStatus,
				status: deriveComponentStatus({
					monitorStatus: component.monitorStatus,
					manualStatus: component.manualStatus,
					incidentStatuses: active
						.filter((incident) => incident.componentIds.includes(component.id))
						.map(incidentComponentStatus),
				}),
				showUptime: component.showUptime,
				monitored: component.monitored,
				days: component.showUptime && component.monitored ? (component.days ?? emptyDays) : [],
			}
		}),
		incidents: input.incidents,
		incidentHistory: input.incidents
			.filter((incident) => !(incident.kind === "maintenance" && incident.status === "scheduled"))
			.map((incident) => ({
				id: incident.id,
				title: incident.title,
				kind: incident.kind,
				impact: incident.impact,
				startedAt: incident.startedAt,
				resolvedAt: incident.resolvedAt,
			})),
	}
}
