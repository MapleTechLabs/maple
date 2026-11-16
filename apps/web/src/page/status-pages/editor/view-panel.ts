import type { StatusPageIncidentImpact } from "@maple/domain"
import type { V2StatusPageIncident } from "@maple/domain/http/v2"
import { formatTimestampInTimezone } from "@maple/ui/lib/timezone-format"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { failureMessage, type LoadFailure } from "@maple/views/data/load-failure"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { button } from "@maple/views/ui/button"
import { badge } from "@maple/views/ui/display"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { timestamp } from "@maple/views/ui/timestamp"
import { INCIDENT_STATUS_LABEL, renderUpdateBody } from "@maple/status-page"
import { cn } from "@maple/ui/lib/utils"
import { relativeTime } from "../../kit/relative-time"
import { IMPACT_LABEL, IMPACT_TONE, isOpenIncident } from "../shared/derive"
import { checkedRows, hasRowIssues } from "../shared/picker"
import { pickerView } from "../shared/picker-view"
import { FocusNewRow } from "./command"
import { Message } from "./message"
import { canPostIncidents, type Model } from "./model"
import { componentsOf, monitorsOf } from "./reads"
import { ADD_PICKER_ID } from "./update-components"
import { typography } from "@maple/views/ui/typography"
import { hstack, vstack, vstackClass } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"

// The side sheet: one incident or maintenance with its actions and updates, or Add monitors.

type H = HtmlBuilder<Message>

export type TimeInputs = Readonly<{ nowMs: number; timeZone: string }>

/** The public page's update markup: paragraphs, lists, code and links. */
const UPDATE_BODY_CLASS =
	"space-y-2 text-sm text-foreground-soft [&_a]:text-primary [&_a]:underline [&_code]:font-mono [&_code]:text-xs [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5"

/** An update's message as the public page renders it, so the editor shows what visitors read. */
export const updateBody = (h: H, body: string, className?: string): Html =>
	h.div(
		[
			h.Class(cn(UPDATE_BODY_CLASS, className)),
			h.DataAttribute("slot", "update-body"),
			h.InnerHTML(renderUpdateBody(body)),
		],
		[],
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

// INCIDENT

/**
 * "Oct 28, 14:00 to 16:00" in the viewer's zone: the maintenance window, or when an incident
 * started and ended ("Since Oct 28, 14:00" while open).
 */
export const windowLine = <M>(
	h: HtmlBuilder<M>,
	incident: V2StatusPageIncident,
	timeZone: string,
): ReadonlyArray<Html | string> | null => {
	const at = (value: string): Html =>
		timestamp(h, {
			value,
			timeZone,
			label: formatTimestampInTimezone(value, { timeZone, style: "range" }),
		})
	if (incident.kind === "incident")
		return incident.resolved_at === null
			? ["Since ", at(incident.started_at)]
			: [at(incident.started_at), " to ", at(incident.resolved_at)]
	if (incident.scheduled_start === null || incident.scheduled_end === null) return null
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

/** The sheet's heading line: status, impact, and whether visitors can see it yet. */
const incidentBadges = (h: H, incident: V2StatusPageIncident): Html =>
	hstack(h, { gap: "1.5", wrap: true }, [
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
	])

/** What the sheet shows for an incident or maintenance: where it stands, what to do next, its updates. */
export const incidentSheetBody = (
	h: H,
	model: Model,
	incident: V2StatusPageIncident,
	time: TimeInputs,
): ReadonlyArray<Html> => {
	const names = Arr.map(
		Arr.filter(componentsOf(model), (component) => incident.component_ids.includes(component.id)),
		(component) => component.name,
	)
	const window = windowLine(h, incident, time.timeZone)
	return [
		vstack(h, { gap: "5" }, [
			vstack(h, { gap: "2" }, [
				incidentBadges(h, incident),
				typography(h, { size: "xs", tone: "muted", as: "p" }, [
					names.length === 0 ? "No components named" : Arr.join(names, ", "),
					...(window === null ? [] : [" · ", ...window]),
					...(incident.kind === "maintenance" && isOpenIncident(incident)
						? [incident.auto_complete ? " · completes on its own" : " · you complete it"]
						: []),
				]),
			]),
			...(canPostIncidents(model) ? [incidentActions(h, model, incident)] : []),
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
								updateBody(h, update.body),
							],
						),
					),
				),
			]),
			...(canPostIncidents(model) ? [deleteIncidentAction(h, incident)] : []),
		]),
	]
}

const deleteIncidentAction = (h: H, incident: V2StatusPageIncident): Html =>
	h.div(
		[h.Class("border-t pt-4")],
		[
			button(
				h,
				{
					size: "sm",
					variant: "destructive-outline",
					attributes: [h.OnClick(Message.ClickedDeleteIncident({ incidentId: incident.id }))],
				},
				[incident.kind === "incident" ? "Delete incident" : "Delete maintenance"],
			),
		],
	)

// ADD

/** Add monitors: the builder's checklist of the monitors not on the page yet. */
export const addSheetBody = (h: H, model: Model): ReadonlyArray<Html> => [
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
]

export const addSheetFooter = (
	h: H,
	model: Model,
	close: ReadonlyArray<ChildAttribute>,
): ReadonlyArray<Html> => {
	const count = checkedRows(model.addPicker).length
	return [
		button(h, { variant: "outline", attributes: close }, ["Cancel"]),
		button(
			h,
			{
				isLoading: model.isAddingComponents,
				isDisabled: count === 0 || hasRowIssues(model.addPicker) || model.addPicker.isCreatingMonitor,
				attributes: [h.OnClick(Message.ClickedSubmitAdd())],
			},
			[count <= 1 ? "Add component" : `Add ${count} components`],
		),
	]
}
