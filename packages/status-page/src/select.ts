import {
	isActiveIncident,
	type StatusPageSnapshot,
	type StatusPageSnapshotComponent,
	type StatusPageSnapshotIncident,
	worstStatus,
} from "@maple/domain/status-page"
import type { StatusPageComponentStatus } from "@maple/domain/primitives"

/** Open incidents and maintenance underway, newest first. */
export const activeIncidents = (snapshot: StatusPageSnapshot): ReadonlyArray<StatusPageSnapshotIncident> =>
	snapshot.incidents.filter(isActiveIncident)

/** Maintenance announced but not started, soonest first. */
export const upcomingMaintenance = (
	snapshot: StatusPageSnapshot,
): ReadonlyArray<StatusPageSnapshotIncident> =>
	snapshot.incidents
		.filter((incident) => incident.kind === "maintenance" && incident.status === "scheduled")
		.sort((a, b) => (a.scheduledStart ?? a.startedAt) - (b.scheduledStart ?? b.startedAt))

/** Resolved incidents and completed maintenance, newest first. */
export const pastIncidents = (snapshot: StatusPageSnapshot): ReadonlyArray<StatusPageSnapshotIncident> =>
	snapshot.incidents
		.filter((incident) => incident.status === "resolved" || incident.status === "completed")
		.sort((a, b) => (b.resolvedAt ?? b.startedAt) - (a.resolvedAt ?? a.startedAt))

export interface ComponentGroup {
	readonly name: string | null
	readonly status: StatusPageComponentStatus
	readonly components: ReadonlyArray<StatusPageSnapshotComponent>
}

/** Components by `group`, in the order each group first appears; ungrouped ones form their own run. */
export const groupComponents = (
	components: ReadonlyArray<StatusPageSnapshotComponent>,
): ReadonlyArray<ComponentGroup> =>
	components
		.reduce<
			ReadonlyArray<{ name: string | null; components: ReadonlyArray<StatusPageSnapshotComponent> }>
		>(
			(groups, component) =>
				groups.some((group) => group.name === component.group)
					? groups.map((group) =>
							group.name === component.group
								? { ...group, components: [...group.components, component] }
								: group,
						)
					: [...groups, { name: component.group, components: [component] }],
			[],
		)
		.map((group) => ({ ...group, status: worstStatus(group.components.map((c) => c.status)) }))

/** The newest moment anything on the page changed. */
export const latestActivityAt = (snapshot: StatusPageSnapshot): number =>
	snapshot.incidents.reduce(
		(latest, incident) =>
			Math.max(latest, incident.startedAt, ...incident.updates.map((update) => update.at)),
		snapshot.generatedAt,
	)
