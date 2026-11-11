import type { StatusPageIncidentImpact } from "@maple/domain"
import type { V2StatusPageComponent, V2StatusPageIncident } from "@maple/domain/http/v2"
import { formatTimestampInTimezone } from "@maple/ui/lib/timezone-format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { failureMessage, type LoadFailure } from "@maple/views/data/load-failure"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { button } from "@maple/views/ui/button"
import * as Checkbox from "@maple/views/ui/checkbox"
import { badge } from "@maple/views/ui/display"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { timestamp } from "@maple/views/ui/timestamp"
import { heading } from "@maple/views/ui/heading"
import { label } from "@maple/views/ui/label"
import { INCIDENT_STATUS_LABEL } from "@maple/status-page"
import { relativeTime } from "../../kit/relative-time"
import {
	COMPONENT_STATUS_LABEL,
	COMPONENT_STATUS_OPTIONS,
	componentStatus,
	IMPACT_LABEL,
	IMPACT_TONE,
	isOpenIncident,
} from "../shared/derive"
import { selectField, textField } from "../shared/fields"
import { checkedRows, hasRowIssues } from "../shared/picker"
import { pickerView } from "../shared/picker-view"
import { FocusNewRow } from "./command"
import { Message } from "./message"
import { canManage, type Model } from "./model"
import { componentsOf, incidentsOf, monitorsOf } from "./reads"
import { ADD_PICKER_ID, PANEL_TITLE_ID } from "./update-components"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack, vstack, vstackClass } from "@maple/views/ui/stack"
import { Array as Arr, String as Str } from "effect"

// The side panel: one component (saved as you go), one incident, or Add component.

type H = HtmlBuilder<Message>

export type TimeInputs = Readonly<{ nowMs: number; timeZone: string }>

const frame = (
	h: H,
	options: Readonly<{ kind: string; title: string; status?: Html }>,
	children: ReadonlyArray<Html>,
): Html =>
	h.aside(
		[
			h.AriaLabelledBy(PANEL_TITLE_ID),
			h.Class("flex min-w-0 flex-col gap-5 rounded-lg border bg-background p-4"),
		],
		[
			vstack(h, { gap: "3", align: "start" }, [
				button(
					h,
					{
						size: "xs",
						variant: "ghost",
						className: "-ml-2",
						attributes: [h.OnClick(Message.ClickedClosePanel())],
					},
					[icon(h, "ArrowLeftIcon"), "On this page"],
				),
				vstack(h, { gap: "1", shrink: true, className: "max-w-full" }, [
					eyebrow(h, {}, [options.kind]),
					heading(
						h,
						{
							level: 2,
							variant: "subsection",
							id: PANEL_TITLE_ID,
							className: "truncate outline-none",
							attributes: [h.Tabindex(-1)],
						},
						[options.title],
					),
					...(options.status === undefined ? [] : [options.status]),
				]),
			]),
			...children,
		],
	)

export const failureAlert = (h: H, title: string, failure: LoadFailure | null): ReadonlyArray<Html> =>
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
					? "font-mono text-xs text-destructive-foreground"
					: typographyClass({ size: "xs", tone: "muted", mono: true }),
			),
		],
		[SAVE_LABEL[model.componentSave]],
	)

/** The page's other groups as one-click picks, so a group is never retyped (or mistyped). */
const groupSuggestions = (h: H, model: Model, isReadOnly: boolean): ReadonlyArray<Html> => {
	const current = Str.trim(model.componentForm.group)
	const groups = Arr.filter(
		Arr.dedupe(Arr.flatMap(componentsOf(model), (row) => (row.group === null ? [] : [row.group]))),
		(group) => group !== current,
	)
	return isReadOnly || groups.length === 0
		? []
		: [
				hstack(
					h,
					{
						gap: "1.5",
						wrap: true,
						className: "-mt-2",
						attributes: [h.Role("group"), h.AriaLabel("Groups on this page")],
					},
					Arr.map(groups, (group) =>
						button(
							h,
							{
								size: "xs",
								variant: "outline",
								attributes: [
									h.Key(group),
									h.OnClick(Message.PickedComponentField({ field: "group", value: group })),
								],
							},
							[group],
						),
					),
				),
			]
}

export const componentPanel = (h: H, model: Model, component: V2StatusPageComponent): Html => {
	const form = model.componentForm
	const isReadOnly = !canManage(model)
	const status = componentStatus(component, monitorsOf(model), incidentsOf(model))
	const hasMonitor = form.monitorId !== ""
	const uptimeId = "status-page-panel-uptime"
	return frame(
		h,
		{
			kind: "Component",
			title: Str.trim(form.name) === "" ? component.name : Str.trim(form.name),
			status: hstack(
				h,
				{ gap: "2", align: "center", className: typographyClass({ size: "xs", tone: "muted" }) },
				[`Visitors see ${COMPONENT_STATUS_LABEL[status]}`, saveIndicator(h, model)],
			),
		},
		[
			...(isReadOnly
				? [
						typography(h, { size: "xs", tone: "muted", as: "p" }, [
							"Only org admins and engineers can change components.",
						]),
					]
				: []),
			vstack(h, { gap: "4" }, [
				textField(h, {
					id: "status-page-panel-name",
					label: "Shown as",
					value: form.name,
					isDisabled: isReadOnly,
					error: Str.trim(form.name) === "" ? "Add a name." : null,
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
				...groupSuggestions(h, model, isReadOnly),
				textField(h, {
					id: "status-page-panel-description",
					label: "Description",
					value: form.description,
					placeholder: "None",
					hint: "A line under the name, for what this covers.",
					isDisabled: isReadOnly,
					onInput: (value) => Message.ChangedComponentField({ field: "description", value }),
					onBlur: Message.CommittedComponent(),
				}),
				selectField(h, {
					id: "status-page-panel-monitor",
					label: "Driven by",
					value: form.monitorId,
					isDisabled: isReadOnly,
					entries: [
						{ value: "", label: "No monitor" },
						...Arr.map(monitorsOf(model), (monitor) => ({
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
						...Arr.map(COMPONENT_STATUS_OPTIONS, (value) => ({
							value,
							label: COMPONENT_STATUS_LABEL[value],
						})),
					],
					onInput: (value) => Message.PickedComponentField({ field: "manualStatus", value }),
				}),
				label(
					h,
					{
						className: "flex font-normal text-sm sm:text-sm",
						attributes: [h.Id(Checkbox.labelId(uptimeId))],
					},
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
			]),
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

/** "Oct 28, 14:00 to 16:00": the maintenance window in the viewer's zone. */
export const windowLine = <M>(
	h: HtmlBuilder<M>,
	incident: V2StatusPageIncident,
	timeZone: string,
): ReadonlyArray<Html | string> | null => {
	if (incident.scheduled_start === null || incident.scheduled_end === null) return null
	const at = (value: string): Html =>
		timestamp(h, {
			value,
			timeZone,
			label: formatTimestampInTimezone(value, { timeZone, style: "range" }),
		})
	return [at(incident.scheduled_start), " to ", at(incident.scheduled_end)]
}

const impactBadgeVariant = (impact: StatusPageIncidentImpact) =>
	IMPACT_TONE[impact] === "neutral" ? "muted" : IMPACT_TONE[impact]

/** An open incident can be published, updated and closed; any incident can have its details edited. */
const incidentActions = (h: H, model: Model, incident: V2StatusPageIncident): Html => {
	const isOpen = isOpenIncident(incident)
	return hstack(h, { gap: "2", align: "stretch", wrap: true }, [
		...(isOpen && !incident.published
			? [
					button(
						h,
						{
							size: "sm",
							isLoading: model.publishingIncidentIds.includes(incident.id),
							attributes: [
								h.OnClick(Message.ClickedPublishIncident({ incidentId: incident.id })),
							],
						},
						["Publish"],
					),
				]
			: []),
		...(isOpen
			? [
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
				]
			: []),
		button(
			h,
			{
				size: "sm",
				variant: "outline",
				attributes: [h.OnClick(Message.ClickedEditIncident({ incidentId: incident.id }))],
			},
			["Edit details"],
		),
	])
}

export const incidentPanel = (h: H, model: Model, incident: V2StatusPageIncident, time: TimeInputs): Html => {
	const names = Arr.map(
		Arr.filter(componentsOf(model), (component) => incident.component_ids.includes(component.id)),
		(component) => component.name,
	)
	const window = windowLine(h, incident, time.timeZone)
	return frame(
		h,
		{
			kind: incident.kind === "incident" ? "Incident" : "Maintenance",
			title: incident.title,
			status: hstack(h, { gap: "1.5", wrap: true }, [
				badge(h, { variant: isOpenIncident(incident) ? "info" : "muted" }, [
					INCIDENT_STATUS_LABEL[incident.status],
				]),
				...(incident.kind === "incident"
					? [
							badge(h, { variant: impactBadgeVariant(incident.impact) }, [
								`${IMPACT_LABEL[incident.impact]} impact`,
							]),
						]
					: []),
				...(incident.published ? [] : [badge(h, { variant: "meta" }, ["Draft, not public"])]),
			]),
		},
		[
			typography(h, { size: "xs", tone: "muted", as: "p" }, [
				names.length === 0 ? "No components named" : Arr.join(names, ", "),
				...(window === null ? [] : [" · ", ...window]),
			]),
			incidentActions(h, model, incident),
			vstack(h, { gap: "2", as: "section", attributes: [h.AriaLabel("Updates")] }, [
				eyebrow(h, { as: "h3" }, ["Updates"]),
				h.ol(
					[h.Class(vstackClass({ gap: "3" }))],
					Arr.map(incident.updates, (update) =>
						vstack(
							h,
							{
								gap: "1",
								as: "li",
								className: "border-l pl-3",
								attributes: [h.Key(update.id)],
							},
							[
								typography(h, { size: "xs", tone: "muted", as: "p" }, [
									typography(h, { tone: "foreground", weight: "medium" }, [
										INCIDENT_STATUS_LABEL[update.status],
									]),
									" · ",
									relativeTime(h, {
										value: update.created_at,
										nowMs: time.nowMs,
										timeZone: time.timeZone,
									}),
								]),
								typography(h, { size: "sm", as: "p", className: "whitespace-pre-wrap" }, [
									update.body,
								]),
							],
						),
					),
				),
			]),
			h.div(
				[h.Class("border-t pt-4")],
				[
					button(
						h,
						{
							size: "sm",
							variant: "destructive-outline",
							attributes: [
								h.OnClick(Message.ClickedDeleteIncident({ incidentId: incident.id })),
							],
						},
						[incident.kind === "incident" ? "Delete incident" : "Delete maintenance"],
					),
				],
			),
		],
	)
}

// ADD

export const addPanel = (h: H, model: Model): Html => {
	const count = checkedRows(model.addPicker).length
	return frame(h, { kind: "Add", title: "Add monitors" }, [
		pickerView(h, {
			picker: model.addPicker,
			monitors: monitorsOf(model),
			toMessage: (message) => Message.GotAddPickerMessage({ message }),
			idPrefix: ADD_PICKER_ID,
			// Locked while a URL is being monitored: its completion submits what is ticked.
			isDisabled: model.isAddingComponents || model.addPicker.isCreatingMonitor,
			focusOnMount: h.OnMount(FocusNewRow()),
			isOrderable: false,
		}),
		hstack(h, { align: "stretch", justify: "end", className: "border-t pt-4" }, [
			button(
				h,
				{
					size: "sm",
					isLoading: model.isAddingComponents,
					isDisabled:
						count === 0 || hasRowIssues(model.addPicker) || model.addPicker.isCreatingMonitor,
					attributes: [h.OnClick(Message.ClickedSubmitAdd())],
				},
				[count <= 1 ? "Add component" : `Add ${count} components`],
			),
		]),
	])
}
