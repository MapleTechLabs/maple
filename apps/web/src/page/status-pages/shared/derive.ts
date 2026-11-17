import {
	StatusPageComponentId,
	StatusPageComponentStatus,
	type StatusPageIncidentImpact,
	type StatusPageIncidentKind,
	type StatusPageIncidentStatus,
} from "@maple/domain"
import {
	V2StatusPage,
	type V2StatusPageComponent,
	V2StatusPageIncident,
	type V2UptimeMonitor,
} from "@maple/domain/http/v2"
import {
	deriveComponentStatus,
	incidentComponentStatus,
	isActiveIncident,
	overallStatus,
	StatusPageDayBar,
	type StatusPagePublicSnapshot,
	worstStatus,
} from "@maple/domain/status-page"
import { toEpochMs } from "@maple/ui/lib/time-format"
import type { Tone } from "@maple/ui/lib/tone"
import { Schema, Array as Arr, Option, Order } from "effect"

// Pure reads of status pages shared by the hub's tab and the editor.

/** Days of uptime bars the list shows per component, as the public page shows at first. */
export const SUMMARY_UPTIME_DAYS = 90

/** A component as visitors see it now, with its last {@link SUMMARY_UPTIME_DAYS} days of bars. */
export const SummaryComponent = Schema.Struct({
	id: StatusPageComponentId,
	name: Schema.String,
	group: Schema.NullOr(Schema.String),
	status: StatusPageComponentStatus,
	/** Backed by an uptime monitor; without one its status is set by hand. */
	monitored: Schema.Boolean,
	/** Oldest first; empty without a monitor or with uptime hidden. */
	days: Schema.Array(StatusPageDayBar),
})
export type SummaryComponent = typeof SummaryComponent.Type

/** A list card: the page, its components as visitors see them, its open incidents and next maintenance. */
export const StatusPageSummary = Schema.Struct({
	page: V2StatusPage,
	overall: StatusPageComponentStatus,
	components: Schema.Array(SummaryComponent),
	/** Open incidents, drafts included, newest first. */
	openIncidents: Schema.Array(V2StatusPageIncident),
	/** Maintenance in progress, else the soonest scheduled; drafts included. */
	maintenance: Schema.NullOr(V2StatusPageIncident),
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

const MONITOR_STATE = {
	up: "up",
	down: "down",
	pending: "waiting for its first check",
	paused: "paused",
} as const satisfies Record<NonNullable<V2UptimeMonitor["state"]["status"]>, string>

/**
 * Why visitors see a status the monitor alone would not give: the open incident behind it, or the
 * override. `null` when the component shows what its monitor says.
 */
export const statusReason = (
	component: V2StatusPageComponent,
	monitors: ReadonlyArray<V2UptimeMonitor>,
	incidents: ReadonlyArray<V2StatusPageIncident>,
): string | null => {
	const monitorStatus = monitorStatusOf(monitors, component.monitor_id)
	const shown = componentStatus(component, monitors, incidents)
	if (shown === (monitorStatus === "down" ? "major_outage" : "operational")) return null
	const label = COMPONENT_STATUS_LABEL[shown]
	const cause = Arr.findFirst(
		incidents,
		(incident) =>
			incident.published &&
			isActiveIncident(incident) &&
			incident.component_ids.includes(component.id) &&
			incidentComponentStatus(incident) === shown,
	)
	const why = Option.match(cause, {
		onSome: (incident) =>
			`${label} by the open ${incident.kind === "incident" ? "incident" : "maintenance"} "${incident.title}".`,
		onNone: () => `${label}, set under Override status.`,
	})
	return monitorStatus === null ? why : `${why} The monitor is ${MONITOR_STATE[monitorStatus]}.`
}

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

const bySoonestStart = Order.mapInput(Order.Number, (incident: V2StatusPageIncident) =>
	toEpochMs(incident.scheduled_start ?? incident.started_at),
)

/** The maintenance worth a line on the card: one in progress, else the soonest scheduled. */
export const nextMaintenance = (
	incidents: ReadonlyArray<V2StatusPageIncident>,
): V2StatusPageIncident | null => {
	const open = Arr.filter(
		incidents,
		(incident) => incident.kind === "maintenance" && isOpenIncident(incident),
	)
	return Option.getOrNull(
		Option.orElse(
			Arr.findFirst(open, (incident) => incident.status === "in_progress"),
			() => Arr.head(Arr.sort(open, bySoonestStart)),
		),
	)
}

/** A list card from the page's live view and the org's open incidents of this page. */
export const summarizePage = (input: {
	readonly page: V2StatusPage
	readonly snapshot: StatusPagePublicSnapshot
	readonly incidents: ReadonlyArray<V2StatusPageIncident>
}): StatusPageSummary => ({
	page: input.page,
	overall: overallStatus(input.snapshot),
	components: Arr.map(input.snapshot.components, (component) => ({
		id: component.id,
		name: component.name,
		group: component.group,
		status: component.status,
		monitored: component.monitored,
		days: Arr.takeRight(component.days, SUMMARY_UPTIME_DAYS),
	})),
	openIncidents: Arr.filter(
		input.incidents,
		(incident) => incident.kind === "incident" && isOpenIncident(incident),
	),
	maintenance: nextMaintenance(input.incidents),
})

/** Whether visitors see an older revision than the page has now. */
export const hasUnpublishedChanges = (page: V2StatusPage): boolean => page.published_revision < page.revision
