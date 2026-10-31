import { StatusPageIncidentImpact } from "@maple/domain"
import type { V2StatusPageIncident } from "@maple/domain/http/v2"
import { formatTimestampInTimezone } from "@maple/web-data/lib/timezone-format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "../../../../ui/alert"
import { button } from "../../../../ui/button"
import * as Checkbox from "../../../../ui/checkbox"
import { badge } from "../../../../ui/display"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../../ui/empty"
import { formDialog } from "../../../../ui/form-dialog"
import { icon } from "../../../../ui/icon"
import { segmentedSelect } from "../../../../ui/segmented-select"
import { failureMessage } from "../../../../data/load-failure"
import { relativeTime } from "../../../kit/relative-time"
import { sectionHeading } from "../../../kit/section-heading"
import {
	closingStatus,
	IMPACT_LABEL,
	INCIDENT_STATUS_LABEL,
	isOpenIncident,
	STATUSES_OF_KIND,
} from "../../shared/status-page-derive"
import { selectField, textareaField, textField } from "../fields"
import { incidentIssues } from "./form"
import { Message } from "./message"
import type { Model } from "./model"
import { componentsOf, incidentsOf } from "./reads"

// The Incidents tab: open incidents and maintenance with their actions, then the closed ones.

type H = HtmlBuilder<Message>

export type TimeInputs = Readonly<{ nowMs: number; timeZone: string }>

const IMPACT_TONE = {
	none: "muted",
	minor: "warn",
	major: "warn",
	critical: "crit",
} as const satisfies Record<StatusPageIncidentImpact, "muted" | "warn" | "crit">

const componentNames = (model: Model, incident: V2StatusPageIncident): string => {
	const names = componentsOf(model)
		.filter((component) => incident.component_ids.includes(component.id))
		.map((component) => component.name)
	return names.length === 0 ? "No components named" : names.join(", ")
}

/** "Oct 28, 14:00 to 16:00": the maintenance window in the viewer's zone. */
const windowLine = (incident: V2StatusPageIncident, timeZone: string): string | null =>
	incident.scheduled_start === null || incident.scheduled_end === null
		? null
		: `${formatTimestampInTimezone(incident.scheduled_start, { timeZone, style: "range" })} to ${formatTimestampInTimezone(incident.scheduled_end, { timeZone, style: "range" })}`

const incidentBadges = (h: H, incident: V2StatusPageIncident): ReadonlyArray<Html> => [
	badge(h, { variant: "outline" }, [incident.kind === "incident" ? "Incident" : "Maintenance"]),
	badge(h, { variant: isOpenIncident(incident) ? "info" : "muted" }, [
		INCIDENT_STATUS_LABEL[incident.status],
	]),
	...(incident.kind === "incident"
		? [badge(h, { variant: IMPACT_TONE[incident.impact] }, [`${IMPACT_LABEL[incident.impact]} impact`])]
		: []),
	...(incident.published ? [] : [badge(h, { variant: "meta" }, ["Draft"])]),
]

const openActions = (h: H, model: Model, incident: V2StatusPageIncident): Html =>
	h.div(
		[h.Class("flex shrink-0 items-center gap-2")],
		[
			...(incident.published
				? []
				: [
						button(
							h,
							{
								size: "sm",
								variant: "outline",
								isLoading: model.publishingIncidentIds.includes(incident.id),
								attributes: [
									h.OnClick(Message.ClickedPublishIncident({ incidentId: incident.id })),
								],
							},
							["Publish draft"],
						),
					]),
			button(
				h,
				{
					size: "sm",
					variant: "outline",
					attributes: [
						h.OnClick(Message.ClickedPostUpdate({ incidentId: incident.id, isResolving: false })),
					],
				},
				["Post update"],
			),
			button(
				h,
				{
					size: "sm",
					variant: "outline",
					attributes: [
						h.OnClick(Message.ClickedPostUpdate({ incidentId: incident.id, isResolving: true })),
					],
				},
				[incident.kind === "incident" ? "Resolve" : "Complete"],
			),
		],
	)

const openCard = (h: H, model: Model, incident: V2StatusPageIncident, time: TimeInputs): Html => {
	const latest = incident.updates[0]
	const window = windowLine(incident, time.timeZone)
	return h.li(
		[h.Key(incident.id), h.Class("flex flex-col gap-3 p-4")],
		[
			h.div(
				[h.Class("flex flex-wrap items-start justify-between gap-3")],
				[
					h.div(
						[h.Class("flex min-w-0 flex-col gap-1.5")],
						[
							h.h3([h.Class("text-sm font-medium")], [incident.title]),
							h.div(
								[h.Class("flex flex-wrap items-center gap-1.5")],
								incidentBadges(h, incident),
							),
						],
					),
					openActions(h, model, incident),
				],
			),
			h.p(
				[h.Class("text-xs text-muted-foreground")],
				[componentNames(model, incident), ...(window === null ? [] : [` · ${window}`])],
			),
			...(latest === undefined
				? []
				: [
						h.div(
							[h.Class("rounded-md bg-muted/40 px-3 py-2")],
							[
								h.p([h.Class("text-sm whitespace-pre-wrap")], [latest.body]),
								h.p(
									[h.Class("mt-1 text-xs text-muted-foreground")],
									[
										`${INCIDENT_STATUS_LABEL[latest.status]} · `,
										relativeTime(h, {
											value: latest.created_at,
											nowMs: time.nowMs,
											timeZone: time.timeZone,
											tooltip: "title",
										}),
									],
								),
							],
						),
					]),
		],
	)
}

const closedRow = (h: H, incident: V2StatusPageIncident, time: TimeInputs): Html =>
	h.li(
		[h.Key(incident.id), h.Class("flex items-center justify-between gap-4 px-4 py-2.5")],
		[
			h.div(
				[h.Class("flex min-w-0 items-center gap-2")],
				[
					h.span([h.Class("truncate text-sm")], [incident.title]),
					badge(h, { variant: "outline" }, [
						incident.kind === "incident" ? "Incident" : "Maintenance",
					]),
				],
			),
			h.span(
				[h.Class("shrink-0 text-xs text-muted-foreground")],
				[
					`${INCIDENT_STATUS_LABEL[incident.status]} `,
					relativeTime(h, {
						value: incident.resolved_at ?? incident.updated_at,
						nowMs: time.nowMs,
						timeZone: time.timeZone,
						tooltip: "title",
					}),
				],
			),
		],
	)

const emptyIncidents = (h: H): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "CircleCheckIcon", { size: 18 })]),
				emptyTitle(h, ["No incidents"]),
				emptyDescription(h, [
					"When something breaks, open an incident and post updates as you learn more. Planned work goes in as scheduled maintenance.",
				]),
			]),
		],
		"rounded-md border py-12",
	)

const headerActions = (h: H): Html =>
	h.div(
		[h.Class("flex items-center gap-2")],
		[
			button(
				h,
				{
					size: "sm",
					variant: "outline",
					attributes: [h.OnClick(Message.ClickedNewIncident({ kind: "maintenance" }))],
				},
				[icon(h, "CalendarIcon"), "Schedule maintenance"],
			),
			button(
				h,
				{ size: "sm", attributes: [h.OnClick(Message.ClickedNewIncident({ kind: "incident" }))] },
				[icon(h, "PlusIcon"), "New incident"],
			),
		],
	)

export const incidentsTab = (h: H, model: Model, time: TimeInputs): Html => {
	const incidents = incidentsOf(model)
	const open = incidents.filter(isOpenIncident)
	const closed = incidents.filter((incident) => !isOpenIncident(incident))
	return h.div(
		[h.Class("flex flex-col gap-8")],
		[
			h.section(
				[h.AriaLabelledBy("status-page-open-incidents"), h.Class("flex flex-col gap-3")],
				[
					sectionHeading(h, {
						id: "status-page-open-incidents",
						title: "Open",
						count: open.length === 0 ? undefined : String(open.length),
						actions: headerActions(h),
					}),
					open.length === 0
						? emptyIncidents(h)
						: h.ul(
								[h.Class("divide-y rounded-md border")],
								open.map((incident) => openCard(h, model, incident, time)),
							),
				],
			),
			...(closed.length === 0
				? []
				: [
						h.section(
							[
								h.AriaLabelledBy("status-page-closed-incidents"),
								h.Class("flex flex-col gap-3"),
							],
							[
								sectionHeading(h, { id: "status-page-closed-incidents", title: "Recent" }),
								h.ul(
									[h.Class("divide-y rounded-md border")],
									closed.map((incident) => closedRow(h, incident, time)),
								),
							],
						),
					]),
		],
	)
}

const statusEntries = (kind: V2StatusPageIncident["kind"], isOpening: boolean) =>
	STATUSES_OF_KIND[kind]
		.filter((status) => !isOpening || status !== closingStatus(kind))
		.map((status) => ({ value: status, label: INCIDENT_STATUS_LABEL[status] }))

const IMPACT_ENTRIES = StatusPageIncidentImpact.literals.map((impact) => ({
	value: impact,
	label: IMPACT_LABEL[impact],
}))

const componentPicker = (h: H, model: Model): Html => {
	const components = componentsOf(model)
	return h.fieldset(
		[h.Class("flex flex-col gap-1.5")],
		[
			h.legend([h.Class("mb-1.5 text-xs text-muted-foreground")], ["Affected components"]),
			components.length === 0
				? h.p([h.Class("text-xs text-muted-foreground")], ["The page has no components yet."])
				: h.div(
						[h.Class("grid grid-cols-2 gap-x-4 gap-y-2")],
						components.map((component) => {
							const inputId = `status-page-incident-component-${component.id}`
							return h.label(
								[
									h.Key(component.id),
									h.Class("flex items-center gap-2 text-sm"),
									h.Id(Checkbox.labelId(inputId)),
								],
								[
									...Checkbox.view(h, {
										model: {
											isChecked: model.incidentForm.componentIds.includes(component.id),
										},
										toParentMessage: () =>
											Message.ToggledIncidentComponent({ componentId: component.id }),
										id: `${inputId}-root`,
										inputId,
									}),
									h.span([h.Class("truncate")], [component.name]),
								],
							)
						}),
					),
		],
	)
}

export const incidentDialog = (h: H, model: Model, timeZone: string): Html => {
	const form = model.incidentForm
	const isMaintenance = form.kind === "maintenance"
	const issues = incidentIssues(form, timeZone)
	return formDialog(h, {
		slotId: "status-page-incident",
		model: model.incidentDialog,
		toParentMessage: (message) => Message.GotIncidentDialogMessage({ message }),
		title: isMaintenance ? "Schedule maintenance" : "New incident",
		description: isMaintenance
			? "Components show as under maintenance while it is in progress."
			: "The first update is what visitors read. Post more as you learn more.",
		onSubmit: Message.SubmittedIncident(),
		submitLabel: form.isPublished ? (isMaintenance ? "Schedule" : "Publish incident") : "Save draft",
		isPending: model.isCreatingIncident,
		isSubmitDisabled: issues.length > 0,
		footerStart:
			issues.length === 0
				? undefined
				: h.p([h.Class("text-xs text-muted-foreground")], [issues[0] ?? ""]),
		fields: [
			h.div(
				[h.Class("flex flex-col gap-4")],
				[
					textField(h, {
						// Not `<slot>-title`: the dialog heading already uses that id.
						id: "status-page-incident-title-field",
						label: "Title",
						value: form.title,
						placeholder: isMaintenance ? "Database upgrade" : "Elevated API errors",
						onInput: (value) => Message.ChangedIncidentField({ field: "title", value }),
					}),
					h.div(
						[h.Class("grid gap-4 sm:grid-cols-2")],
						[
							selectField(h, {
								id: "status-page-incident-status",
								label: "Status",
								value: form.status,
								entries: statusEntries(form.kind, true),
								onInput: (value) => Message.ChangedIncidentField({ field: "status", value }),
							}),
							...(isMaintenance
								? []
								: [
										selectField(h, {
											id: "status-page-incident-impact",
											label: "Impact",
											value: form.impact,
											entries: IMPACT_ENTRIES,
											onInput: (value) =>
												Message.ChangedIncidentField({ field: "impact", value }),
										}),
									]),
						],
					),
					...(isMaintenance
						? [
								h.div(
									[h.Class("grid gap-4 sm:grid-cols-2")],
									[
										textField(h, {
											id: "status-page-incident-start",
											label: "Starts",
											type: "datetime-local",
											value: form.scheduledStart,
											onInput: (value) =>
												Message.ChangedIncidentField({
													field: "scheduledStart",
													value,
												}),
										}),
										textField(h, {
											id: "status-page-incident-end",
											label: "Ends",
											type: "datetime-local",
											value: form.scheduledEnd,
											hint: `Times are in ${timeZone}.`,
											onInput: (value) =>
												Message.ChangedIncidentField({
													field: "scheduledEnd",
													value,
												}),
										}),
									],
								),
							]
						: []),
					componentPicker(h, model),
					textareaField(h, {
						id: "status-page-incident-body",
						label: "Message",
						value: form.body,
						placeholder: isMaintenance
							? "We are upgrading the primary database. Expect brief read-only periods."
							: "We are looking into elevated error rates on the API.",
						onInput: (value) => Message.ChangedIncidentField({ field: "body", value }),
					}),
					h.div(
						[h.Class("flex flex-col gap-1.5")],
						[
							h.span([h.Class("text-xs text-muted-foreground")], ["Visibility"]),
							segmentedSelect(h, {
								ariaLabel: "Visibility",
								size: "sm",
								value: form.isPublished ? "publish" : "draft",
								onChange: (value) =>
									Message.PickedIncidentPublished({ isPublished: value === "publish" }),
								options: [
									{ value: "publish", label: "Publish now" },
									{ value: "draft", label: "Save as draft" },
								],
							}),
						],
					),
					...(model.incidentFailure === null
						? []
						: [
								alert(h, { variant: "crit", size: "sm" }, [
									icon(h, "CircleXmarkIcon"),
									alertTitle(h, [
										isMaintenance ? "Couldn't schedule it" : "Couldn't open the incident",
									]),
									alertDescription(h, [failureMessage(model.incidentFailure)]),
								]),
							]),
				],
			),
		],
	})
}

export const updateDialog = (h: H, model: Model): Html => {
	const form = model.updateForm
	const incident = incidentsOf(model).find((row) => row.id === form?.incidentId)
	return formDialog(h, {
		slotId: "status-page-update",
		model: model.updateDialog,
		toParentMessage: (message) => Message.GotUpdateDialogMessage({ message }),
		title: "Post an update",
		description: incident?.title ?? "",
		onSubmit: Message.SubmittedUpdate(),
		submitLabel: "Post update",
		isPending: model.isPostingUpdate,
		isSubmitDisabled: form === null || form.body.trim() === "",
		fields:
			form === null
				? []
				: [
						h.div(
							[h.Class("flex flex-col gap-4")],
							[
								selectField(h, {
									id: "status-page-update-status",
									label: "Status",
									value: form.status,
									entries: statusEntries(form.kind, false),
									hint:
										form.status === closingStatus(form.kind)
											? "This closes it on the page."
											: undefined,
									onInput: (value) =>
										Message.ChangedUpdateField({ field: "status", value }),
								}),
								textareaField(h, {
									id: "status-page-update-body",
									label: "Message",
									value: form.body,
									onInput: (value) => Message.ChangedUpdateField({ field: "body", value }),
								}),
								...(model.updateFailure === null
									? []
									: [
											alert(h, { variant: "crit", size: "sm" }, [
												icon(h, "CircleXmarkIcon"),
												alertTitle(h, ["Couldn't post the update"]),
												alertDescription(h, [failureMessage(model.updateFailure)]),
											]),
										]),
							],
						),
					],
	})
}
