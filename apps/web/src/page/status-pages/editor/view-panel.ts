import { StatusPageIncidentImpact } from "@maple/domain"
import type { V2StatusPageComponent, V2StatusPageIncident } from "@maple/domain/http/v2"
import { formatTimestampInTimezone } from "@maple/web-data/lib/timezone-format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { failureMessage, type LoadFailure } from "../../../data/load-failure"
import { alert, alertDescription, alertTitle } from "../../../ui/alert"
import { button } from "../../../ui/button"
import * as Checkbox from "../../../ui/checkbox"
import { badge } from "../../../ui/display"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import { segmentedSelect } from "../../../ui/segmented-select"
import { relativeTime } from "../../kit/relative-time"
import {
	closingStatus,
	COMPONENT_STATUS_LABEL,
	COMPONENT_STATUS_OPTIONS,
	componentStatus,
	IMPACT_LABEL,
	INCIDENT_STATUS_LABEL,
	isOpenIncident,
	STATUSES_OF_KIND,
} from "../shared/derive"
import { selectField, textareaField, textField } from "../shared/fields"
import { incidentIssues } from "../shared/form"
import { checkedRows, hasRowIssues } from "../shared/picker"
import { pickerView } from "../shared/picker-view"
import { FocusNewRow } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { componentsOf, incidentsOf, monitorsOf } from "./reads"
import { ADD_PICKER_ID, PANEL_TITLE_ID } from "./update-components"
import { UPDATE_BODY_ID } from "./update-incidents"

// The side panel: one component (saved as you go), one incident, the composer, or Add component.

type H = HtmlBuilder<Message>

export type TimeInputs = Readonly<{ nowMs: number; timeZone: string }>

const frame = (
	h: H,
	options: Readonly<{ kind: string; title: string; status?: Html; label: string }>,
	children: ReadonlyArray<Html>,
): Html =>
	h.aside(
		[
			h.AriaLabelledBy(PANEL_TITLE_ID),
			h.Class("flex min-w-0 flex-col gap-5 rounded-lg border bg-background p-4 lg:sticky lg:top-0"),
		],
		[
			h.div(
				[h.Class("flex items-start justify-between gap-3")],
				[
					h.div(
						[h.Class("flex min-w-0 flex-col gap-1")],
						[
							eyebrow(h, {}, [options.kind]),
							h.h2(
								[
									h.Id(PANEL_TITLE_ID),
									h.Tabindex(-1),
									h.Class("truncate text-sm font-medium outline-none"),
								],
								[options.title],
							),
							...(options.status === undefined ? [] : [options.status]),
						],
					),
					iconButton(
						h,
						{
							label: `Close ${options.label}`,
							size: "icon-xs",
							attributes: [h.OnClick(Message.ClickedClosePanel())],
						},
						[icon(h, "XmarkIcon")],
					),
				],
			),
			...children,
		],
	)

const failureAlert = (h: H, title: string, failure: LoadFailure | null): ReadonlyArray<Html> =>
	failure === null
		? []
		: [
				alert(h, { variant: "crit", size: "sm" }, [
					icon(h, "CircleXmarkIcon"),
					alertTitle(h, [title]),
					alertDescription(h, [failureMessage(failure)]),
				]),
			]

// COMPONENT

const SAVE_LABEL = { idle: "", saving: "Saving", saved: "Saved", failed: "Not saved" } as const

const saveIndicator = (h: H, model: Model): Html =>
	h.span(
		[
			h.AriaLive("polite"),
			h.Class(
				model.componentSave === "failed"
					? "font-mono text-xs text-destructive"
					: "font-mono text-xs text-muted-foreground",
			),
		],
		[SAVE_LABEL[model.componentSave]],
	)

export const componentPanel = (h: H, model: Model, component: V2StatusPageComponent): Html => {
	const form = model.componentForm
	const isReadOnly = !model.isAdmin
	const status = componentStatus(component, monitorsOf(model), incidentsOf(model))
	const hasMonitor = form.monitorId !== ""
	const uptimeId = "status-page-panel-uptime"
	return frame(
		h,
		{
			kind: "Component",
			title: form.name.trim() === "" ? component.name : form.name.trim(),
			label: "component",
			status: h.div(
				[h.Class("flex items-center gap-2 text-xs text-muted-foreground")],
				[`Visitors see ${COMPONENT_STATUS_LABEL[status]}`, saveIndicator(h, model)],
			),
		},
		[
			...(isReadOnly
				? [
						h.p(
							[h.Class("text-xs text-muted-foreground")],
							["Only org admins can change components."],
						),
					]
				: []),
			h.div(
				[h.Class("flex flex-col gap-4")],
				[
					textField(h, {
						id: "status-page-panel-name",
						label: "Shown as",
						value: form.name,
						isDisabled: isReadOnly,
						error: form.name.trim() === "" ? "Add a name." : null,
						onInput: (value) => Message.ChangedComponentField({ field: "name", value }),
						onBlur: Message.CommittedComponent(),
					}),
					textField(h, {
						id: "status-page-panel-group",
						label: "Group",
						value: form.group,
						placeholder: "None",
						hint: "Components with one group are listed under it.",
						isDisabled: isReadOnly,
						onInput: (value) => Message.ChangedComponentField({ field: "group", value }),
						onBlur: Message.CommittedComponent(),
					}),
					selectField(h, {
						id: "status-page-panel-monitor",
						label: "Driven by",
						value: form.monitorId,
						isDisabled: isReadOnly,
						entries: [
							{ value: "", label: "No monitor" },
							...monitorsOf(model).map((monitor) => ({
								value: monitor.id,
								label: monitor.name,
							})),
						],
						onInput: (value) => Message.PickedComponentField({ field: "monitorId", value }),
					}),
					selectField(h, {
						id: "status-page-panel-status",
						label: "Override status",
						value: form.manualStatus,
						isDisabled: isReadOnly,
						hint: hasMonitor
							? "Automatic follows the monitor and open incidents."
							: "Automatic follows open incidents.",
						entries: [
							{ value: "", label: "Automatic" },
							...COMPONENT_STATUS_OPTIONS.map((value) => ({
								value,
								label: COMPONENT_STATUS_LABEL[value],
							})),
						],
						onInput: (value) => Message.PickedComponentField({ field: "manualStatus", value }),
					}),
					h.label(
						[h.Id(Checkbox.labelId(uptimeId)), h.Class("flex items-center gap-2 text-sm")],
						[
							...Checkbox.view(h, {
								// The stored value, shown as is; it only takes effect once a monitor drives the component.
								model: { isChecked: form.showUptime },
								toParentMessage: () => Message.ToggledComponentUptime(),
								id: `${uptimeId}-root`,
								inputId: uptimeId,
								isDisabled: isReadOnly || !hasMonitor,
							}),
							h.span([], ["Show uptime bars"]),
						],
					),
					...(hasMonitor
						? []
						: [
								h.p(
									[h.Class("-mt-2 text-xs text-muted-foreground")],
									["Uptime bars need a monitor."],
								),
							]),
				],
			),
			...failureAlert(h, "Couldn't save the component", model.componentFailure),
			...(isReadOnly
				? []
				: [
						h.div(
							[h.Class("border-t pt-4")],
							[
								button(
									h,
									{
										size: "sm",
										variant: "destructive-outline",
										attributes: [
											h.OnClick(
												Message.ClickedDeleteComponent({ componentId: component.id }),
											),
										],
									},
									["Remove from page"],
								),
							],
						),
					]),
		],
	)
}

// INCIDENT

const IMPACT_TONE = {
	none: "muted",
	minor: "warn",
	major: "warn",
	critical: "crit",
} as const satisfies Record<StatusPageIncidentImpact, "muted" | "warn" | "crit">

const statusEntries = (kind: V2StatusPageIncident["kind"], isOpening: boolean) =>
	STATUSES_OF_KIND[kind]
		.filter((status) => !isOpening || status !== closingStatus(kind))
		.map((status) => ({ value: status, label: INCIDENT_STATUS_LABEL[status] }))

const IMPACT_ENTRIES = StatusPageIncidentImpact.literals.map((impact) => ({
	value: impact,
	label: IMPACT_LABEL[impact],
}))

/** "Oct 28, 14:00 to 16:00": the maintenance window in the viewer's zone. */
const windowLine = (incident: V2StatusPageIncident, timeZone: string): string | null =>
	incident.scheduled_start === null || incident.scheduled_end === null
		? null
		: `${formatTimestampInTimezone(incident.scheduled_start, { timeZone, style: "range" })} to ${formatTimestampInTimezone(incident.scheduled_end, { timeZone, style: "range" })}`

const updateForm = (h: H, model: Model): ReadonlyArray<Html> => {
	const form = model.updateForm
	if (form === null) return []
	return [
		h.form(
			[
				h.AriaLabel("Post an update"),
				h.OnSubmit(Message.SubmittedUpdate()),
				h.Class("flex flex-col gap-3 rounded-md border bg-muted/30 p-3"),
			],
			[
				selectField(h, {
					id: "status-page-update-status",
					label: "Status",
					value: form.status,
					entries: statusEntries(form.kind, false),
					hint:
						form.status === closingStatus(form.kind) ? "This closes it on the page." : undefined,
					onInput: (value) => Message.ChangedUpdateField({ field: "status", value }),
				}),
				textareaField(h, {
					id: UPDATE_BODY_ID,
					label: "Message",
					value: form.body,
					onInput: (value) => Message.ChangedUpdateField({ field: "body", value }),
				}),
				...failureAlert(h, "Couldn't post the update", model.updateFailure),
				h.div(
					[h.Class("flex justify-end gap-2")],
					[
						button(
							h,
							{
								size: "sm",
								variant: "ghost",
								isDisabled: model.isPostingUpdate,
								attributes: [h.OnClick(Message.ClickedCancelUpdate())],
							},
							["Cancel"],
						),
						button(
							h,
							{
								size: "sm",
								type: "submit",
								isLoading: model.isPostingUpdate,
								isDisabled: form.body.trim() === "",
							},
							[
								form.status === closingStatus(form.kind)
									? form.kind === "incident"
										? "Resolve"
										: "Complete"
									: "Post update",
							],
						),
					],
				),
			],
		),
	]
}

const incidentActions = (h: H, model: Model, incident: V2StatusPageIncident): ReadonlyArray<Html> =>
	!isOpenIncident(incident) || model.updateForm !== null
		? []
		: [
				h.div(
					[h.Class("flex flex-wrap gap-2")],
					[
						...(incident.published
							? []
							: [
									button(
										h,
										{
											size: "sm",
											isLoading: model.publishingIncidentIds.includes(incident.id),
											attributes: [
												h.OnClick(
													Message.ClickedPublishIncident({
														incidentId: incident.id,
													}),
												),
											],
										},
										["Publish"],
									),
								]),
						button(
							h,
							{
								size: "sm",
								variant: "outline",
								attributes: [
									h.OnClick(
										Message.ClickedPostUpdate({
											incidentId: incident.id,
											isResolving: false,
										}),
									),
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
									h.OnClick(
										Message.ClickedPostUpdate({
											incidentId: incident.id,
											isResolving: true,
										}),
									),
								],
							},
							[incident.kind === "incident" ? "Resolve" : "Complete"],
						),
					],
				),
			]

export const incidentPanel = (h: H, model: Model, incident: V2StatusPageIncident, time: TimeInputs): Html => {
	const names = componentsOf(model)
		.filter((component) => incident.component_ids.includes(component.id))
		.map((component) => component.name)
	const window = windowLine(incident, time.timeZone)
	return frame(
		h,
		{
			kind: incident.kind === "incident" ? "Incident" : "Maintenance",
			title: incident.title,
			label: incident.kind,
			status: h.div(
				[h.Class("flex flex-wrap items-center gap-1.5")],
				[
					badge(h, { variant: isOpenIncident(incident) ? "info" : "muted" }, [
						INCIDENT_STATUS_LABEL[incident.status],
					]),
					...(incident.kind === "incident"
						? [
								badge(h, { variant: IMPACT_TONE[incident.impact] }, [
									`${IMPACT_LABEL[incident.impact]} impact`,
								]),
							]
						: []),
					...(incident.published ? [] : [badge(h, { variant: "meta" }, ["Draft, not public"])]),
				],
			),
		},
		[
			h.p(
				[h.Class("text-xs text-muted-foreground")],
				[
					names.length === 0 ? "No components named" : names.join(", "),
					...(window === null ? [] : [` · ${window}`]),
				],
			),
			...incidentActions(h, model, incident),
			...updateForm(h, model),
			h.section(
				[h.AriaLabel("Updates"), h.Class("flex flex-col gap-2")],
				[
					eyebrow(h, { as: "h3" }, ["Updates"]),
					h.ol(
						[h.Class("flex flex-col gap-3")],
						incident.updates.map((update) =>
							h.li(
								[h.Key(update.id), h.Class("flex flex-col gap-1 border-l pl-3")],
								[
									h.p(
										[h.Class("text-xs text-muted-foreground")],
										[
											h.span(
												[h.Class("font-medium text-foreground")],
												[INCIDENT_STATUS_LABEL[update.status]],
											),
											" · ",
											relativeTime(h, {
												value: update.created_at,
												nowMs: time.nowMs,
												timeZone: time.timeZone,
												tooltip: "title",
											}),
										],
									),
									h.p([h.Class("text-sm whitespace-pre-wrap")], [update.body]),
								],
							),
						),
					),
				],
			),
		],
	)
}

// COMPOSER

const componentChecklist = (h: H, model: Model): Html => {
	const components = componentsOf(model)
	return h.fieldset(
		[h.Class("flex flex-col gap-1.5")],
		[
			h.legend([h.Class("mb-1.5 text-xs text-muted-foreground")], ["Affected components"]),
			components.length === 0
				? h.p([h.Class("text-xs text-muted-foreground")], ["The page has no components yet."])
				: h.div(
						[h.Class("flex flex-col gap-2")],
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

export const composerPanel = (h: H, model: Model, timeZone: string): Html => {
	const form = model.incidentForm
	const isMaintenance = form.kind === "maintenance"
	const issues = incidentIssues(form, timeZone)
	return frame(
		h,
		{ kind: "New", title: isMaintenance ? "Schedule maintenance" : "Post incident", label: "composer" },
		[
			h.form(
				[
					h.AriaLabelledBy(PANEL_TITLE_ID),
					h.OnSubmit(Message.SubmittedIncident()),
					h.Class("flex flex-col gap-4"),
				],
				[
					segmentedSelect(h, {
						size: "sm",
						ariaLabel: "Kind",
						className: "self-start",
						value: form.kind,
						onChange: (kind) => Message.ChangedIncidentKind({ kind }),
						options: [
							{ value: "incident", label: "Incident" },
							{ value: "maintenance", label: "Maintenance" },
						],
					}),
					textField(h, {
						id: "status-page-incident-title-field",
						label: "Title",
						value: form.title,
						placeholder: isMaintenance ? "Database upgrade" : "Elevated API errors",
						onInput: (value) => Message.ChangedIncidentField({ field: "title", value }),
					}),
					h.div(
						[h.Class("grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2")],
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
								textField(h, {
									id: "status-page-incident-start",
									label: "Starts",
									type: "datetime-local",
									value: form.scheduledStart,
									onInput: (value) =>
										Message.ChangedIncidentField({ field: "scheduledStart", value }),
								}),
								textField(h, {
									id: "status-page-incident-end",
									label: "Ends",
									type: "datetime-local",
									value: form.scheduledEnd,
									hint: `Times are in ${timeZone}.`,
									onInput: (value) =>
										Message.ChangedIncidentField({ field: "scheduledEnd", value }),
								}),
							]
						: []),
					componentChecklist(h, model),
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
								className: "self-start",
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
					...failureAlert(
						h,
						isMaintenance ? "Couldn't schedule it" : "Couldn't open the incident",
						model.incidentFailure,
					),
					h.div(
						[h.Class("flex items-center justify-between gap-3 border-t pt-4")],
						[
							h.p([h.Class("text-xs text-muted-foreground")], [issues[0] ?? ""]),
							button(
								h,
								{
									size: "sm",
									type: "submit",
									isLoading: model.isCreatingIncident,
									isDisabled: issues.length > 0,
								},
								[
									form.isPublished
										? isMaintenance
											? "Schedule"
											: "Publish incident"
										: "Save draft",
								],
							),
						],
					),
				],
			),
		],
	)
}

// ADD

export const addPanel = (h: H, model: Model): Html => {
	const count = checkedRows(model.addPicker).length
	return frame(h, { kind: "Add", title: "Add components", label: "Add components" }, [
		pickerView(h, {
			picker: model.addPicker,
			monitors: monitorsOf(model),
			toMessage: (message) => Message.GotAddPickerMessage({ message }),
			idPrefix: ADD_PICKER_ID,
			isDisabled: model.isAddingComponents,
			focusOnMount: h.OnMount(FocusNewRow()),
			isOrderable: false,
		}),
		...failureAlert(h, "Couldn't add every component", model.addFailure),
		h.div(
			[h.Class("flex justify-end border-t pt-4")],
			[
				button(
					h,
					{
						size: "sm",
						isLoading: model.isAddingComponents,
						isDisabled: count === 0 || hasRowIssues(model.addPicker),
						attributes: [h.OnClick(Message.ClickedSubmitAdd())],
					},
					[count <= 1 ? "Add component" : `Add ${count} components`],
				),
			],
		),
	])
}
