import type { V2StatusPageComponent } from "@maple/domain/http/v2"
import { Array as Arr, Option, String as Str } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import * as Combobox from "@maple/views/ui/combobox"
import { comboboxPicker, triggerIdOf } from "@maple/views/ui/combobox-picker"
import { dragGrip } from "@maple/views/ui/drag-grip"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { label } from "@maple/views/ui/label"
import { pressable } from "@maple/views/ui/pressable"
import { grid } from "@maple/views/ui/grid"
import { hstack, vstack } from "@maple/views/ui/stack"
import { statusDot } from "@maple/views/ui/status-dot"
import { switchControl } from "@maple/views/ui/switch"
import { type TypographyTone, typography } from "@maple/views/ui/typography"
import type { Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { expandChevron } from "../../kit/expand-chevron"
import { saveBar } from "../../kit/save-bar"
import { adminOnlyNote, settingsSection } from "../../kit/settings-section"
import {
	COMPONENT_STATUS_LABEL,
	COMPONENT_STATUS_OPTIONS,
	COMPONENT_STATUS_TONE,
	componentStatus,
	statusReason,
} from "../shared/derive"
import { controlField, selectField, textField } from "../shared/fields"
import { RevealOpenComponent } from "./command"
import { GRIP_ATTRIBUTE, LIST_ATTRIBUTE, ROW_ATTRIBUTE, SLOT_ATTRIBUTE } from "./component-drag"
import { Message } from "./message"
import { canManage, type ComponentSave, type Model } from "./model"
import { componentsOf, incidentsOf, listedComponentsOf, monitorsOf } from "./reads"
import {
	componentGripId,
	componentRowId,
	GROUP_PICKER_ID,
	groupedOrder,
	unsavedComponent,
	unsavedOrder,
} from "./update-components"
import { failureAlert } from "./view-panel"

// Settings > Monitors: the page's components by group, each opening in place with its fields and
// reordered by its grip, both saved from one bar; the page preview beside Settings shows how it reads.

type H = HtmlBuilder<Message>

const LABEL_TONE = {
	ok: "muted",
	info: "muted",
	warn: "warning",
	crit: "error",
} as const satisfies Partial<Record<Tone, TypographyTone>>

const SAVE_LABEL = { Saving: "Saving", Saved: "Saved", Failed: "Not saved" } as const satisfies Record<
	ComponentSave["_tag"],
	string
>

/** The last save, when it was this component's. */
const saveOf = (model: Model, component: V2StatusPageComponent): ComponentSave | null =>
	model.componentSave?.componentId === component.id ? model.componentSave : null

const saveIndicator = (h: H, save: ComponentSave | null): Html =>
	typography(
		h,
		{
			size: "xs",
			mono: true,
			tone: save?._tag === "Failed" ? "destructive" : "muted",
			attributes: [h.AriaLive("polite")],
		},
		[save === null ? "" : SAVE_LABEL[save._tag]],
	)

/**
 * Group: the page's groups and "No group" in a list, the search naming a new one. A component
 * that shares its group with others is listed under it.
 */
const groupPicker = (h: H, model: Model, isReadOnly: boolean): Html => {
	const form = model.componentForm
	const current = { ...model.groupPicker, selected: [form.group] }
	const groups = Arr.dedupe([
		...Arr.flatMap(componentsOf(model), (row) => (row.group === null ? [] : [row.group])),
		...(Str.trim(form.group) === "" ? [] : [form.group]),
	])
	const typed = Str.trim(Combobox.queryOf(current))
	const items =
		typed === ""
			? ["", ...groups]
			: [...Combobox.filterItems(groups, typed), ...(groups.includes(typed) ? [] : [typed])]
	const triggerId = triggerIdOf(GROUP_PICKER_ID)
	return controlField(
		h,
		{ id: triggerId, label: "Group" },
		h.submodel({
			slotId: `${GROUP_PICKER_ID}-slot`,
			model: current,
			view: comboboxPicker,
			toParentMessage: (message) => Message.GotGroupPickerMessage({ message }),
			viewInputs: {
				items,
				// The label replaces the trigger's text for screen readers, so it carries the pick.
				ariaLabel: form.group === "" ? "Group" : `Group: ${form.group}`,
				searchPlaceholder: "Find or name a group",
				emptyText: "No groups yet",
				trigger: [form.group === "" ? "No group" : form.group],
				isPlaceholder: form.group === "",
				isDisabled: isReadOnly,
				triggerClassName: "h-8 w-full sm:h-8",
				renderItem: (_h, value) =>
					value === "" ? ["No group"] : groups.includes(value) ? [value] : [`New group "${value}"`],
				toView: (parts) => h.div([], parts),
			},
		}),
	)
}

/** Why the component shows what it shows, when that is not its monitor's plain reading. */
const reasonLine = (h: H, model: Model, component: V2StatusPageComponent): ReadonlyArray<Html> => {
	const reason = statusReason(component, monitorsOf(model), incidentsOf(model))
	const tone = COMPONENT_STATUS_TONE[componentStatus(component, monitorsOf(model), incidentsOf(model))]
	return reason === null
		? []
		: [
				hstack(h, { gap: "2", align: "start" }, [
					typography(h, { tone: LABEL_TONE[tone], className: "mt-px shrink-0" }, [
						icon(h, "AlertWarningIcon", { size: 14 }),
					]),
					typography(h, { size: "xs", tone: "muted", as: "p" }, [reason]),
				]),
			]
}

/** The open component's fields, why it shows what it shows. The page preview beside Settings shows its row. */
const componentForm = (h: H, model: Model, component: V2StatusPageComponent): Html => {
	const form = model.componentForm
	const isReadOnly = !canManage(model)
	const hasMonitor = form.monitorId !== ""
	const uptimeId = "status-page-panel-uptime"
	const save = saveOf(model, component)
	return vstack(
		h,
		{
			gap: "4",
			// Level with the row's status dot, past the grip.
			className: cn("pt-1 pr-4 pb-4", isReadOnly ? "pl-4" : "pl-10.5"),
			attributes: model.revealComponentId === component.id ? [h.OnMount(RevealOpenComponent())] : [],
		},
		[
			...(isReadOnly
				? [adminOnlyNote(h, ["Only org admins and engineers can change components."])]
				: []),
			grid(h, { sm: 2, gap: "4", className: "items-start" }, [
				textField(h, {
					id: "status-page-panel-name",
					label: "Shown as",
					value: form.name,
					isDisabled: isReadOnly,
					error: Str.trim(form.name) === "" ? "Add a name." : null,
					onInput: (value) => Message.ChangedComponentField({ field: "name", value }),
				}),
				groupPicker(h, model, isReadOnly),
			]),
			textField(h, {
				id: "status-page-panel-description",
				label: "Description",
				value: form.description,
				placeholder: "Optional",
				isDisabled: isReadOnly,
				onInput: (value) => Message.ChangedComponentField({ field: "description", value }),
			}),
			grid(h, { sm: 2, gap: "4", className: "items-start" }, [
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
					onInput: (value) => Message.ChangedComponentField({ field: "monitorId", value }),
				}),
				selectField(h, {
					id: "status-page-panel-status",
					label: "Override status",
					value: form.manualStatus,
					isDisabled: isReadOnly,
					entries: [
						{ value: "", label: "Automatic" },
						...Arr.map(COMPONENT_STATUS_OPTIONS, (value) => ({
							value,
							label: COMPONENT_STATUS_LABEL[value],
						})),
					],
					onInput: (value) => Message.ChangedComponentField({ field: "manualStatus", value }),
				}),
			]),
			...reasonLine(h, model, component),
			vstack(h, { gap: "1" }, [
				label(
					h,
					{
						className: "flex items-center gap-2 font-normal text-sm sm:text-sm",
						attributes: [h.Id(`${uptimeId}-label`)],
					},
					[
						...switchControl(h, {
							// The stored value, shown as is; it only takes effect once a monitor drives the component.
							id: uptimeId,
							inputId: `${uptimeId}-input`,
							isChecked: form.showUptime,
							isDisabled: isReadOnly || !hasMonitor,
							labelledBy: `${uptimeId}-label`,
							onToggle: Message.ToggledComponentUptime(),
						}),
						"Show uptime bars",
					],
				),
				...(hasMonitor
					? []
					: [
							typography(h, { size: "xs", tone: "muted", as: "p" }, [
								"Uptime bars need a monitor.",
							]),
						]),
			]),
			...failureAlert(h, "Couldn't save the component", save?._tag === "Failed" ? save.failure : null),
			hstack(h, { gap: "3", justify: "between", wrap: true }, [
				isReadOnly
					? h.span([], [])
					: button(
							h,
							{
								size: "sm",
								variant: "destructive-ghost",
								// Its text level with the fields above.
								className: "-ml-2.5",
								attributes: [
									h.OnClick(Message.ClickedDeleteComponent({ componentId: component.id })),
								],
							},
							["Remove from page"],
						),
				saveIndicator(h, save),
			]),
		],
	)
}

const REORDER_HINT_ID = "status-page-reorder-hint"

/** The row's handle: dragged, or moved a slot with the arrow keys, within its group. */
const grip = (h: H, model: Model, component: V2StatusPageComponent): Html =>
	dragGrip(h, {
		label: `Reorder ${component.name}`,
		onMove: (offset) => Message.PressedMoveComponent({ componentId: component.id, offset }),
		className: "self-stretch px-1",
		attributes: [
			h.Id(componentGripId(component.id)),
			h.DataAttribute(GRIP_ATTRIBUTE, ""),
			h.AriaDescribedBy(REORDER_HINT_ID),
			// Still focusable while the order saves, so the keyboard keeps its place.
			h.AriaDisabled(model.isSavingOrder),
		],
	})

/** What drives the component: its monitor by name, or incidents alone. */
const sourceLine = (model: Model, component: V2StatusPageComponent): string =>
	component.monitor_id === null
		? "No monitor. Follows incidents only"
		: Option.match(
				Arr.findFirst(monitorsOf(model), (monitor) => monitor.id === component.monitor_id),
				{ onNone: () => "Monitor not found", onSome: (monitor) => `Monitor: ${monitor.name}` },
			)

const componentRow = (h: H, model: Model, component: V2StatusPageComponent): Html => {
	const status = componentStatus(component, monitorsOf(model), incidentsOf(model))
	const isOpen = model.panel?._tag === "Component" && model.panel.componentId === component.id
	return h.li(
		[
			h.Key(component.id),
			h.DataAttribute(ROW_ATTRIBUTE, component.id),
			h.Class(
				"border-t first:border-t-0 data-dragging:relative data-dragging:z-10 data-dragging:rounded-md data-dragging:bg-card data-dragging:shadow-popup data-dragging:outline data-dragging:outline-primary-a4",
			),
		],
		[
			hstack(h, { gap: "1", className: "pl-2" }, [
				...(canManage(model) ? [grip(h, model, component)] : []),
				pressable(
					h,
					{
						onClick: Message.ClickedComponent({ componentId: component.id }),
						className: cn(
							"flex min-w-0 flex-1 items-center gap-3 px-2 py-3 text-left hover:bg-surface-sunken active:bg-surface-sunken",
							isOpen && "bg-surface-sunken",
						),
						attributes: [h.Id(componentRowId(component.id)), h.AriaExpanded(isOpen)],
					},
					[
						statusDot(h, { tone: COMPONENT_STATUS_TONE[status], size: "lg" }),
						typography(
							h,
							{ size: "sm", weight: "medium", truncate: true, className: "shrink-0" },
							[component.name],
						),
						typography(h, { size: "xs", tone: "muted", mono: true, truncate: true }, [
							sourceLine(model, component),
						]),
						typography(
							h,
							{
								size: "xs",
								tone: LABEL_TONE[COMPONENT_STATUS_TONE[status]],
								className: "ml-auto shrink-0",
							},
							[COMPONENT_STATUS_LABEL[status]],
						),
						expandChevron(h, isOpen),
					],
				),
			]),
			...(isOpen ? [componentForm(h, model, component)] : []),
		],
	)
}

/** The components under each group's head, in page order, ungrouped last. */
const componentList = (h: H, model: Model): Html => {
	const rows = groupedOrder(listedComponentsOf(model))
	const groups = Arr.dedupe(Arr.map(rows, (row) => row.group))
	const hasGroups = Arr.some(groups, (group) => group !== null)
	return vstack(h, { attributes: [h.AriaLabel("Components")] }, [
		...(canManage(model)
			? [
					h.span(
						[h.Id(REORDER_HINT_ID), h.Class("sr-only")],
						["Drag, or press the up and down arrow keys, to move it within its group."],
					),
				]
			: []),
		...(model.orderFailure === null
			? []
			: [
					h.div(
						[h.Key("order-failure"), h.Class("p-4 pb-0")],
						failureAlert(h, "Couldn't save the order", model.orderFailure),
					),
				]),
		...Arr.map(groups, (group) =>
			vstack(h, { attributes: [h.Key(group ?? "")] }, [
				...(hasGroups
					? [
							h.div(
								[h.Class("bg-surface-sunken px-4 py-2")],
								[eyebrow(h, {}, [group ?? "No group"])],
							),
						]
					: []),
				// The slot outline sits under the rows; a drag moves it to where the held row lands.
				h.div(
					[h.DataAttribute(LIST_ATTRIBUTE, ""), h.Class("relative")],
					[
						h.div(
							[
								h.DataAttribute(SLOT_ATTRIBUTE, ""),
								h.AriaHidden(true),
								h.Class(
									"pointer-events-none invisible absolute inset-x-1 top-0 rounded-md border border-dashed border-primary-a4 bg-primary-a1 data-dragging:visible",
								),
							],
							[],
						),
						h.ul(
							[h.AriaLabel(group ?? "No group")],
							Arr.map(
								Arr.filter(rows, (row) => row.group === group),
								(component) => componentRow(h, model, component),
							),
						),
					],
				),
			]),
		),
	])
}

/**
 * The Monitors save bar, while the order was moved or the open component's form differs from it, or
 * either saves. Save sends both.
 */
export const monitorsSaveBar = (h: H, model: Model): ReadonlyArray<Html> => {
	const unsaved = Option.getOrNull(unsavedComponent(model))
	const isOrderUnsaved = Option.isSome(unsavedOrder(model))
	const isNameMissing = unsaved !== null && Str.trim(model.componentForm.name) === ""
	const save = model.componentSave
	return saveBar(h, {
		isDirty: unsaved !== null || isOrderUnsaved,
		isPending:
			model.isSavingOrder ||
			(save?._tag === "Saving" && save.componentId === model.componentForm.editingId),
		context: isNameMissing
			? "Fix the fields marked above."
			: Arr.join(
					[...(isOrderUnsaved ? ["New order"] : []), ...(unsaved === null ? [] : [unsaved.name])],
					", ",
				),
		onDiscard: Message.ClickedDiscardMonitors(),
		onSave: Message.ClickedSaveMonitors(),
		// One save at a time, even another component's.
		isSaveDisabled: isNameMissing || save?._tag === "Saving" || model.isSavingOrder,
	})
}

export const monitorsSection = (h: H, model: Model): Html =>
	settingsSection(
		h,
		{
			id: "status-page-settings-monitors",
			title: "Monitors",
			description: ["Each one is a row under System status, in this order."],
			padded: false,
			actions: canManage(model)
				? button(
						h,
						{
							size: "sm",
							// Reopened mid-save, Add would list the monitors being added again.
							isLoading: model.isAddingComponents,
							attributes: [h.OnClick(Message.ClickedAddComponent())],
						},
						[icon(h, "PlusIcon"), "Add monitors"],
					)
				: undefined,
		},
		[
			componentsOf(model).length === 0
				? typography(h, { size: "sm", tone: "muted", as: "p", className: "p-4" }, [
						canManage(model)
							? "Nothing yet. Add a monitor and visitors see its status and uptime."
							: "No monitors on this page yet.",
					])
				: componentList(h, model),
		],
	)
