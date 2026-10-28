import { StatusPageComponentStatus } from "@maple/domain"
import type { V2StatusPageComponent, V2UptimeMonitor } from "@maple/domain/http/v2"
import { TONE_FILL } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "../../../../ui/alert"
import { button } from "../../../../ui/button"
import * as Checkbox from "../../../../ui/checkbox"
import { confirmDialog } from "../../../../ui/confirm-dialog"
import { badge } from "../../../../ui/display"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../../ui/empty"
import { formDialog } from "../../../../ui/form-dialog"
import { icon } from "../../../../ui/icon"
import { iconButton } from "../../../../ui/icon-button"
import { failureMessage } from "../../../../data/load-failure"
import { sectionHeading } from "../../../kit/section-heading"
import { emptyActions } from "../../../kit/signal-empty-state"
import {
	COMPONENT_STATUS_LABEL,
	COMPONENT_STATUS_TONE,
	componentStatus,
} from "../../shared/status-page-derive"
import { selectField, textareaField, textField } from "../fields"
import { Message } from "./message"
import type { Model } from "./model"
import { componentsOf, incidentsOf, monitorsOf } from "./reads"

// The Components tab: each line of the page in order, and the add or edit dialog.

type H = HtmlBuilder<Message>

const statusChip = (h: H, status: StatusPageComponentStatus): Html =>
	h.span(
		[h.Class("flex items-center gap-1.5 text-xs text-muted-foreground")],
		[
			h.span(
				[
					h.AriaHidden(true),
					h.Class(
						cn(
							"inline-block size-2 shrink-0 rounded-[2px]",
							TONE_FILL[COMPONENT_STATUS_TONE[status]],
						),
					),
				],
				[],
			),
			COMPONENT_STATUS_LABEL[status],
		],
	)

/** What drives the line: its monitor, the override, or nothing but incidents. */
const sourceLine = (component: V2StatusPageComponent, monitors: ReadonlyArray<V2UptimeMonitor>): string => {
	const monitor = monitors.find((row) => row.id === component.monitor_id)
	const parts = [
		component.monitor_id === null ? "No monitor" : `Monitor ${monitor?.name ?? "not found"}`,
		...(component.manual_status === null
			? []
			: [`set to ${COMPONENT_STATUS_LABEL[component.manual_status].toLowerCase()}`]),
		...(component.show_uptime && component.monitor_id !== null ? ["uptime bars shown"] : []),
	]
	return parts.join(" · ")
}

const rowActions = (
	h: H,
	model: Model,
	component: V2StatusPageComponent,
	index: number,
	count: number,
): Html =>
	h.div(
		[h.Class("flex shrink-0 items-center gap-0.5")],
		[
			iconButton(
				h,
				{
					label: `Move ${component.name} up`,
					isDisabled: index === 0 || model.isReordering,
					attributes: [
						h.OnClick(Message.ClickedMoveComponent({ componentId: component.id, offset: -1 })),
					],
				},
				[icon(h, "ArrowUpIcon")],
			),
			iconButton(
				h,
				{
					label: `Move ${component.name} down`,
					isDisabled: index === count - 1 || model.isReordering,
					attributes: [
						h.OnClick(Message.ClickedMoveComponent({ componentId: component.id, offset: 1 })),
					],
				},
				[icon(h, "ArrowDownIcon")],
			),
			iconButton(
				h,
				{
					label: `Edit ${component.name}`,
					attributes: [h.OnClick(Message.ClickedEditComponent({ componentId: component.id }))],
				},
				[icon(h, "PencilIcon")],
			),
			iconButton(
				h,
				{
					label: `Remove ${component.name}`,
					attributes: [h.OnClick(Message.ClickedDeleteComponent({ componentId: component.id }))],
				},
				[icon(h, "TrashIcon")],
			),
		],
	)

const componentRow = (
	h: H,
	model: Model,
	component: V2StatusPageComponent,
	index: number,
	count: number,
): Html => {
	const monitors = monitorsOf(model)
	return h.li(
		[h.Key(component.id), h.Class("flex items-center gap-4 py-3 pr-2 pl-4")],
		[
			h.div(
				[h.Class("min-w-0 flex-1")],
				[
					h.div(
						[h.Class("flex min-w-0 items-center gap-2")],
						[
							h.span([h.Class("truncate text-sm font-medium")], [component.name]),
							...(component.group === null
								? []
								: [badge(h, { variant: "secondary" }, [component.group])]),
						],
					),
					h.p(
						[h.Class("truncate text-xs text-muted-foreground")],
						[sourceLine(component, monitors)],
					),
				],
			),
			statusChip(h, componentStatus(component, monitors, incidentsOf(model))),
			...(model.isAdmin ? [rowActions(h, model, component, index, count)] : []),
		],
	)
}

const emptyComponents = (h: H, model: Model): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "LayersIcon", { size: 18 })]),
				emptyTitle(h, ["No components yet"]),
				emptyDescription(h, [
					"Components are the lines visitors see, like API or Dashboard. Link one to an uptime monitor and it goes down when the monitor does.",
				]),
			]),
			...(model.isAdmin
				? [
						emptyActions(h, [
							button(
								h,
								{ size: "sm", attributes: [h.OnClick(Message.ClickedAddComponent())] },
								[icon(h, "PlusIcon"), "Add component"],
							),
						]),
					]
				: []),
		],
		"rounded-md border py-12",
	)

export const componentsTab = (h: H, model: Model): Html => {
	const components = componentsOf(model)
	return h.section(
		[h.AriaLabelledBy("status-page-components"), h.Class("flex flex-col gap-3")],
		[
			sectionHeading(h, {
				id: "status-page-components",
				title: "Components",
				count: components.length === 0 ? undefined : String(components.length),
				actions:
					model.isAdmin && components.length > 0
						? button(
								h,
								{
									size: "sm",
									variant: "outline",
									attributes: [h.OnClick(Message.ClickedAddComponent())],
								},
								[icon(h, "PlusIcon"), "Add component"],
							)
						: undefined,
			}),
			components.length === 0
				? emptyComponents(h, model)
				: h.ul(
						[h.Class("divide-y rounded-md border")],
						components.map((component, index) =>
							componentRow(h, model, component, index, components.length),
						),
					),
		],
	)
}

const MANUAL_STATUS_ENTRIES = [
	{ value: "", label: "Follow the monitor and incidents" },
	...StatusPageComponentStatus.literals.map((status) => ({
		value: status,
		label: COMPONENT_STATUS_LABEL[status],
	})),
]

export const componentDialog = (h: H, model: Model): Html => {
	const form = model.componentForm
	const monitorEntries = [
		{ value: "", label: "None" },
		...monitorsOf(model).map((monitor) => ({ value: monitor.id, label: monitor.name })),
	]
	const uptimeInputId = "status-page-component-uptime"
	return formDialog(h, {
		slotId: "status-page-component",
		model: model.componentDialog,
		toParentMessage: (message) => Message.GotComponentDialogMessage({ message }),
		title: form.editingId === null ? "Add component" : "Edit component",
		description: "Its status is the worst of its monitor, the override and the incidents naming it.",
		onSubmit: Message.SubmittedComponent(),
		submitLabel: form.editingId === null ? "Add component" : "Save component",
		isPending: model.isSavingComponent,
		isSubmitDisabled: form.name.trim() === "",
		fields: [
			h.div(
				[h.Class("flex flex-col gap-4")],
				[
					textField(h, {
						id: "status-page-component-name",
						label: "Name",
						value: form.name,
						placeholder: "API",
						onInput: (value) => Message.ChangedComponentField({ field: "name", value }),
					}),
					textareaField(h, {
						id: "status-page-component-description",
						label: "Description",
						value: form.description,
						hint: "Optional. Shown under the name.",
						onInput: (value) => Message.ChangedComponentField({ field: "description", value }),
					}),
					textField(h, {
						id: "status-page-component-group",
						label: "Group",
						value: form.group,
						placeholder: "Core services",
						hint: "Optional. Components with the same group are listed under one heading.",
						onInput: (value) => Message.ChangedComponentField({ field: "group", value }),
					}),
					selectField(h, {
						id: "status-page-component-monitor",
						label: "Uptime monitor",
						value: form.monitorId,
						entries: monitorEntries,
						hint: "A monitor that is down shows the component as a major outage.",
						onInput: (value) => Message.ChangedComponentField({ field: "monitorId", value }),
					}),
					selectField(h, {
						id: "status-page-component-status",
						label: "Status override",
						value: form.manualStatus,
						entries: MANUAL_STATUS_ENTRIES,
						onInput: (value) => Message.ChangedComponentField({ field: "manualStatus", value }),
					}),
					h.label(
						[h.Class("flex items-center gap-2 text-sm"), h.Id(Checkbox.labelId(uptimeInputId))],
						[
							...Checkbox.view(h, {
								model: { isChecked: form.showUptime },
								toParentMessage: () => Message.ToggledComponentUptime(),
								id: `${uptimeInputId}-root`,
								inputId: uptimeInputId,
							}),
							"Show 90 days of uptime bars",
						],
					),
					...(model.componentFailure === null
						? []
						: [
								alert(h, { variant: "crit", size: "sm" }, [
									icon(h, "CircleXmarkIcon"),
									alertTitle(h, ["Couldn't save the component"]),
									alertDescription(h, [failureMessage(model.componentFailure)]),
								]),
							]),
				],
			),
		],
	})
}

export const deleteComponentDialog = (h: H, model: Model): Html => {
	const target = componentsOf(model).find((component) => component.id === model.confirmDeleteComponentId)
	return confirmDialog(h, {
		slotId: "status-page-delete-component",
		model: model.deleteComponentDialog,
		toParentMessage: (message) => Message.GotDeleteComponentDialogMessage({ message }),
		title: `Remove ${target?.name ?? "component"}?`,
		description: "It disappears from the page with the next publish. Incidents keep their history.",
		confirmLabel: "Remove component",
		isPending: model.isDeletingComponent,
		onConfirm: Message.ClickedConfirmDeleteComponent(),
	})
}
