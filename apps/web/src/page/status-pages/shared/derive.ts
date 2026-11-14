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
import { Schema, Array as Arr, Option } from "effect"

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

/** An impact's colour: the dot beside it and the rule of its post. */
export const IMPACT_TONE = {
	none: "neutral",
	minor: "warn",
	major: "warn",
	critical: "crit",
} as const satisfies Record<StatusPageIncidentImpact, Tone>

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

/** The status of the component's monitor; null without one. */
export const monitorStatusOf = (
	monitors: ReadonlyArray<V2UptimeMonitor>,
	monitorId: V2UptimeMonitor["id"] | null,
): V2UptimeMonitor["state"]["status"] | null =>
	Option.match(
		Arr.findFirst(monitors, (monitor) => monitor.id === monitorId),
		{ onNone: () => null, onSome: (monitor) => monitor.state.status ?? null },
	)

/** What of an incident moves component statuses: an unsaved draft has these too. */
export type StatusInput = Pick<
	V2StatusPageIncident,
	"published" | "kind" | "status" | "impact" | "component_ids"
>

/** What a visitor sees for one component: monitor, override and published active incidents. */
export const componentStatus = (
	component: V2StatusPageComponent,
	monitors: ReadonlyArray<V2UptimeMonitor>,
	incidents: ReadonlyArray<StatusInput>,
): StatusPageComponentStatus =>
	deriveComponentStatus({
		monitorStatus: monitorStatusOf(monitors, component.monitor_id),
		manualStatus: component.manual_status,
		incidentStatuses: Arr.map(
			Arr.filter(
				incidents,
				(incident) =>
					incident.published &&
					isActiveIncident(incident) &&
					incident.component_ids.includes(component.id),
			),
			incidentComponentStatus,
		),
	})

/** The page banner: the worst component, as the public page derives it. */
export const pageStatus = (
	components: ReadonlyArray<V2StatusPageComponent>,
	monitors: ReadonlyArray<V2UptimeMonitor>,
	incidents: ReadonlyArray<StatusInput>,
): StatusPageComponentStatus =>
	worstStatus(Arr.map(components, (component) => componentStatus(component, monitors, incidents)))

/** One status a visitor would see change: the page banner (`componentId` null) or a component. */
export type StatusChange = Readonly<{
	componentId: V2StatusPageComponent["id"] | null
	label: string
	from: StatusPageComponentStatus
	to: StatusPageComponentStatus
}>

/** What visitors would see change from `before` to `after`: the banner first, then components in page order. */
export const statusChanges = (input: {
	readonly components: ReadonlyArray<V2StatusPageComponent>
	readonly monitors: ReadonlyArray<V2UptimeMonitor>
	readonly before: ReadonlyArray<StatusInput>
	readonly after: ReadonlyArray<StatusInput>
}): ReadonlyArray<StatusChange> =>
	Arr.filter(
		[
			{
				componentId: null,
				label: "Page banner",
				from: pageStatus(input.components, input.monitors, input.before),
				to: pageStatus(input.components, input.monitors, input.after),
			},
			...Arr.map(input.components, (component) => ({
				componentId: component.id,
				label: component.name,
				from: componentStatus(component, input.monitors, input.before),
				to: componentStatus(component, input.monitors, input.after),
			})),
		],
		(change) => change.from !== change.to,
	)

export const summarizePage = (input: {
	readonly page: V2StatusPage
	readonly components: ReadonlyArray<V2StatusPageComponent>
	readonly incidents: ReadonlyArray<V2StatusPageIncident>
	readonly monitors: ReadonlyArray<V2UptimeMonitor>
}): StatusPageSummary => ({
	page: input.page,
	overall: pageStatus(input.components, input.monitors, input.incidents),
	componentCount: input.components.length,
	openIncidents: Arr.filter(input.incidents, isOpenIncident).length,
})

/** Whether visitors see an older revision than the page has now. */
export const hasUnpublishedChanges = (page: V2StatusPage): boolean => page.published_revision < page.revision
