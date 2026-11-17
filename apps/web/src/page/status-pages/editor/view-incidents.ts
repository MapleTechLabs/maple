import type { StatusPageIncidentKind } from "@maple/domain"
import type { V2StatusPageIncident } from "@maple/domain/http/v2"
import { INCIDENT_STATUS_LABEL } from "@maple/status-page"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { formatDateInTimezone } from "@maple/ui/lib/timezone-format"
import { Option, Array as Arr } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { badge } from "@maple/views/ui/display"
import { emptyMessage } from "@maple/views/ui/empty"
import { panel } from "@maple/views/ui/panel"
import { pressable } from "@maple/views/ui/pressable"
import { hstack, vstack } from "@maple/views/ui/stack"
import { statusDot } from "@maple/views/ui/status-dot"
import {
	clickableRowClass,
	table,
	tableBody,
	tableCell,
	tableHead,
	tableHeader,
	tableRow,
	truncatedTableCell,
} from "@maple/views/ui/table"
import { timestamp } from "@maple/views/ui/timestamp"
import { typography } from "@maple/views/ui/typography"
import { relativeTime } from "../../kit/relative-time"
import { sectionHeading } from "../../kit/section-heading"
import { IMPACT_LABEL, IMPACT_TONE, isOpenIncident } from "../shared/derive"
import { Message } from "./message"
import { canPostIncidents, type Model } from "./model"
import { componentsOf, incidentsOf } from "./reads"
import { type TimeInputs, windowLine } from "./view-panel"

// The Incidents and Maintenance tabs: what is open or coming, then what is over. A row opens the
// incident in the side sheet.

type H = HtmlBuilder<Message>

type Column = Readonly<{
	label: string
	className?: string
	cell: (incident: V2StatusPageIncident) => ReadonlyArray<Html | string>
}>

/** "2h 40m", "24m", "<1m". */
const durationLabel = (ms: number): string => {
	const minutes = Math.round(ms / 60_000)
	if (minutes < 1) return "<1m"
	const hours = Math.floor(minutes / 60)
	const rest = minutes % 60
	return hours === 0 ? `${rest}m` : rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

/**
 * How long completed maintenance ran: from its first In progress update to its completion, else
 * its scheduled window; `null` with neither.
 */
export const maintenanceDurationMs = (incident: V2StatusPageIncident): number | null => {
	const started = Arr.reduce(incident.updates, null as number | null, (earliest, update) =>
		update.status !== "in_progress"
			? earliest
			: Math.min(earliest ?? Infinity, toEpochMs(update.created_at)),
	)
	if (started !== null && incident.resolved_at !== null) return toEpochMs(incident.resolved_at) - started
	return incident.scheduled_start === null || incident.scheduled_end === null
		? null
		: toEpochMs(incident.scheduled_end) - toEpochMs(incident.scheduled_start)
}

const componentNames = (model: Model, incident: V2StatusPageIncident): string => {
	const names = Arr.map(
		Arr.filter(componentsOf(model), (component) => incident.component_ids.includes(component.id)),
		(component) => component.name,
	)
	return names.length === 0 ? "None" : Arr.join(names, ", ")
}

/** The title cell: the button that opens the incident, with its tone square and a draft marker. */
const titleCell = (h: H, incident: V2StatusPageIncident): Html =>
	truncatedTableCell(h, [
		hstack(h, { gap: "2" }, [
			...(isOpenIncident(incident)
				? [
						statusDot(h, {
							tone: incident.kind === "maintenance" ? "info" : IMPACT_TONE[incident.impact],
							size: "lg",
							className: "rounded-xs",
						}),
					]
				: []),
			pressable(
				h,
				{
					onClick: Message.ClickedIncident({ incidentId: incident.id }),
					className: "min-w-0 truncate text-left text-sm font-medium",
				},
				[incident.title],
			),
			...(incident.published ? [] : [badge(h, { variant: "meta" }, ["Draft"])]),
		]),
	])

const incidentTable = (
	h: H,
	options: Readonly<{
		title: string
		empty: string
		rows: ReadonlyArray<V2StatusPageIncident>
		first: string
		columns: ReadonlyArray<Column>
	}>,
): Html =>
	vstack(h, { gap: "3", as: "section", attributes: [h.AriaLabel(options.title)] }, [
		sectionHeading(h, { title: options.title }),
		options.rows.length === 0
			? emptyMessage(h, { dashed: true, className: "px-4 py-6" }, [options.empty])
			: panel(h, {}, [
					table(h, { ariaLabel: options.title, className: "table-fixed" }, [
						tableHeader(h, [
							tableRow(h, [
								tableHead(h, [options.first], "px-4"),
								...Arr.map(options.columns, (column) =>
									tableHead(h, [column.label], column.className ?? "w-40 px-3"),
								),
							]),
						]),
						tableBody(
							h,
							Arr.map(options.rows, (incident) =>
								tableRow(
									h,
									[
										titleCell(h, incident),
										...Arr.map(options.columns, (column) =>
											tableCell(
												h,
												column.cell(incident),
												"px-3 text-xs text-muted-foreground",
											),
										),
									],
									clickableRowClass(false),
									[
										h.Key(incident.id),
										h.OnClick(Message.ClickedIncident({ incidentId: incident.id })),
									],
								),
							),
						),
					]),
				]),
	])

const ofKind = (model: Model, kind: StatusPageIncidentKind) =>
	Arr.filter(incidentsOf(model), (incident) => incident.kind === kind)

export const incidentsTab = (h: H, model: Model, time: TimeInputs): Html => {
	const incidents = ofKind(model, "incident")
	const components = (incident: V2StatusPageIncident) => [componentNames(model, incident)]
	return vstack(h, { gap: "8" }, [
		incidentTable(h, {
			title: "Active",
			empty: "No open incidents.",
			first: "Incident",
			rows: Arr.filter(incidents, isOpenIncident),
			columns: [
				{ label: "Status", cell: (incident) => [INCIDENT_STATUS_LABEL[incident.status]] },
				{ label: "Components", cell: components },
				{
					label: "Started",
					cell: (incident) => [
						relativeTime(h, {
							value: incident.started_at,
							nowMs: time.nowMs,
							timeZone: time.timeZone,
						}),
					],
				},
			],
		}),
		incidentTable(h, {
			title: "Resolved",
			empty: "No resolved incidents yet.",
			first: "Incident",
			rows: Arr.filter(incidents, (incident) => !isOpenIncident(incident)),
			columns: [
				{ label: "Impact", cell: (incident) => [IMPACT_LABEL[incident.impact]] },
				{ label: "Components", cell: components },
				{
					label: "Date",
					cell: (incident) => [
						timestamp(h, {
							value: incident.resolved_at ?? incident.started_at,
							timeZone: time.timeZone,
							label: formatDateInTimezone(incident.resolved_at ?? incident.started_at, {
								timeZone: time.timeZone,
								withYear: false,
							}),
						}),
					],
				},
			],
		}),
	])
}

/** Whether the maintenance completes on its own, as the list shows it. */
const endsBadge = (h: H, incident: V2StatusPageIncident): Html =>
	incident.auto_complete
		? badge(h, { variant: "ok", pill: true }, ["Auto-complete"])
		: badge(h, { variant: "meta", pill: true }, ["You complete it"])

/**
 * When in-progress maintenance ends: a countdown, or once a manual one runs past its window, how
 * far over it is with the button that completes it.
 */
const endsCell = (
	h: H,
	model: Model,
	incident: V2StatusPageIncident,
	time: TimeInputs,
): ReadonlyArray<Html | string> => {
	if (incident.scheduled_end === null) return ["\u2013"]
	const overMs = time.nowMs - toEpochMs(incident.scheduled_end)
	if (overMs < 0)
		return [
			relativeTime(h, { value: incident.scheduled_end, nowMs: time.nowMs, timeZone: time.timeZone }),
		]
	if (incident.auto_complete) return ["Completing now"]
	return [
		hstack(h, { gap: "3", justify: "between" }, [
			typography(h, { tone: "warning", className: "whitespace-nowrap" }, [
				`${durationLabel(overMs)} over`,
			]),
			...(canPostIncidents(model)
				? [
						button(
							h,
							{
								variant: "outline",
								size: "xs",
								attributes: [
									h.OnClick(
										Message.ClickedPostUpdate({
											incidentId: incident.id,
											isResolving: true,
										}),
										{ propagation: "Stop" },
									),
								],
							},
							["Complete"],
						),
					]
				: []),
		]),
	]
}

/** Who completed it, by its latest completion (updates are newest first): the sweep or a person. */
const completedBy = (incident: V2StatusPageIncident): string =>
	Option.match(
		Arr.findFirst(incident.updates, (update) => update.status === "completed"),
		{
			onNone: () => "Manually",
			onSome: (update) => (update.source === "auto" ? "Automatically" : "Manually"),
		},
	)

export const maintenanceTab = (h: H, model: Model, time: TimeInputs): Html => {
	const maintenance = ofKind(model, "maintenance")
	const components = (incident: V2StatusPageIncident) => [componentNames(model, incident)]
	const window = (incident: V2StatusPageIncident) => windowLine(h, incident, time.timeZone) ?? ["Not set"]
	const inProgress = Arr.filter(maintenance, (incident) => incident.status === "in_progress")
	const whenItEnds: Column = {
		label: "When it ends",
		className: "w-40 px-3",
		cell: (incident) => [endsBadge(h, incident)],
	}
	return vstack(h, { gap: "8" }, [
		...(inProgress.length === 0
			? []
			: [
					incidentTable(h, {
						title: "In progress",
						empty: "",
						first: "Maintenance",
						rows: inProgress,
						columns: [
							{ label: "Window", className: "w-72 px-3", cell: window },
							{ label: "Components", cell: components },
							whenItEnds,
							{
								label: "Ends",
								className: "w-48 px-3",
								cell: (incident) => endsCell(h, model, incident, time),
							},
						],
					}),
				]),
		incidentTable(h, {
			title: "Upcoming",
			empty: "No maintenance scheduled.",
			first: "Maintenance",
			rows: Arr.filter(maintenance, (incident) => incident.status === "scheduled"),
			columns: [
				{ label: "Window", className: "w-72 px-3", cell: window },
				{ label: "Components", cell: components },
				whenItEnds,
				{
					label: "Starts",
					className: "w-48 px-3",
					cell: (incident) => [
						relativeTime(h, {
							value: incident.scheduled_start ?? incident.started_at,
							nowMs: time.nowMs,
							timeZone: time.timeZone,
						}),
					],
				},
			],
		}),
		incidentTable(h, {
			title: "Completed",
			empty: "No completed maintenance yet.",
			first: "Maintenance",
			rows: Arr.filter(maintenance, (incident) => !isOpenIncident(incident)),
			columns: [
				{ label: "Window", className: "w-72 px-3", cell: window },
				{ label: "Components", cell: components },
				{ label: "Completed", className: "w-40 px-3", cell: (incident) => [completedBy(incident)] },
				{
					label: "Duration",
					className: "w-48 px-3",
					cell: (incident) => {
						const ms = maintenanceDurationMs(incident)
						return [ms === null ? "\u2013" : durationLabel(ms)]
					},
				},
			],
		}),
	])
}

/** The open incident count on the Incidents tab. */
export const openIncidentCount = (model: Model): number =>
	Arr.filter(ofKind(model, "incident"), isOpenIncident).length
