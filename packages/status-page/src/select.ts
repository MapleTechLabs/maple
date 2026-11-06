import {
	isActiveIncident,
	type StatusPageSnapshot,
	type StatusPageSnapshotComponent,
	type StatusPageSnapshotIncident,
	worstStatus,
} from "@maple/domain/status-page"
import type { StatusPageComponentStatus } from "@maple/domain/primitives"
import { Array as Arr } from "effect"

/** Open incidents and maintenance underway, newest first. */
export const activeIncidents = (snapshot: StatusPageSnapshot): ReadonlyArray<StatusPageSnapshotIncident> =>
	Arr.filter(snapshot.incidents, isActiveIncident)

/** Maintenance announced but not started, soonest first. */
export const upcomingMaintenance = (
	snapshot: StatusPageSnapshot,
): ReadonlyArray<StatusPageSnapshotIncident> =>
	Arr.filter(
		snapshot.incidents,
		(incident) => incident.kind === "maintenance" && incident.status === "scheduled",
	).sort((a, b) => (a.scheduledStart ?? a.startedAt) - (b.scheduledStart ?? b.startedAt))

/** Resolved incidents and completed maintenance, newest first. */
export const pastIncidents = (snapshot: StatusPageSnapshot): ReadonlyArray<StatusPageSnapshotIncident> =>
	Arr.filter(
		snapshot.incidents,
		(incident) => incident.status === "resolved" || incident.status === "completed",
	).sort((a, b) => (b.resolvedAt ?? b.startedAt) - (a.resolvedAt ?? a.startedAt))

export interface ComponentGroup {
	readonly name: string | null
	readonly status: StatusPageComponentStatus
	readonly components: ReadonlyArray<StatusPageSnapshotComponent>
}

/** Components by `group`, in the order each group first appears; ungrouped ones form their own run. */
export const groupComponents = (
	components: ReadonlyArray<StatusPageSnapshotComponent>,
): ReadonlyArray<ComponentGroup> =>
	Arr.map(
		Arr.reduce<
			StatusPageSnapshotComponent,
			ReadonlyArray<{ name: string | null; components: ReadonlyArray<StatusPageSnapshotComponent> }>
		>(components, [], (groups, component) =>
			Arr.some(groups, (group) => group.name === component.group)
				? Arr.map(groups, (group) =>
						group.name === component.group
							? { ...group, components: [...group.components, component] }
							: group,
					)
				: [...groups, { name: component.group, components: [component] }],
		),
		(group) => ({ ...group, status: worstStatus(Arr.map(group.components, (c) => c.status)) }),
	)

/** The newest moment anything on the page changed. */
export const latestActivityAt = (snapshot: StatusPageSnapshot): number =>
	Arr.reduce(snapshot.incidents, snapshot.generatedAt, (latest, incident) =>
		Math.max(latest, incident.startedAt, ...Arr.map(incident.updates, (update) => update.at)),
	)
