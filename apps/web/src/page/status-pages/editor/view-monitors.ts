import type { V2StatusPageComponent } from "@maple/domain/http/v2"
import { Array as Arr, Option, String as Str } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { icon } from "@maple/views/ui/icon"
import { hstack, vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { saveBar } from "../../kit/save-bar"
import { adminOnlyNote, settingsSection } from "../../kit/settings-section"
import {
	componentFields,
	componentList,
	LABEL_TONE,
	removeButton,
	sourceLine,
} from "../shared/component-list"
import { groupedOrder } from "../shared/component-order"
import { COMPONENT_STATUS_TONE, componentStatus, statusReason } from "../shared/derive"
import { groupPickerField, groupsOf } from "../shared/group-picker"
import { RevealOpenComponent } from "./command"
import { Message } from "./message"
import { canManage, type ComponentSave, type Model } from "./model"
import { gatedControl } from "../../kit/session-grants"
import { componentsOf, incidentsOf, listedComponentsOf, monitorsOf } from "./reads"
import {
	componentGripId,
	componentRowId,
	groupGripId,
	unsavedComponent,
	unsavedOrder,
} from "./update-components"
import { failureAlert } from "./view-panel"

// Settings > Monitors: the page's components by group, each opening in place with its fields and
// reordered by its grip, both saved from one bar; the page preview beside Settings shows how it reads.

type H = HtmlBuilder<Message>

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
const componentBody = (h: H, model: Model, component: V2StatusPageComponent): ReadonlyArray<Html> => {
	const isReadOnly = !canManage(model)
	const save = saveOf(model, component)
	return [
		...(isReadOnly ? [adminOnlyNote(h, ["Only org admins and engineers can change components."])] : []),
		...componentFields(h, {
			idPrefix: "status-page-panel",
			form: model.componentForm,
			monitors: monitorsOf(model),
			isReadOnly,
			onField: (field, value) => Message.ChangedComponentField({ field, value }),
			onToggleUptime: Message.ToggledComponentUptime(),
			group: groupPickerField(h, {
				picker: model.groupPicker,
				groups: groupsOf(Arr.map(listedComponentsOf(model), (row) => row.group)),
				current: model.componentForm.group,
				isDisabled: isReadOnly,
				toMessage: (message) => Message.GotGroupPickerMessage({ message }),
			}),
		}),
		...reasonLine(h, model, component),
		...failureAlert(h, "Couldn't save the component", save?._tag === "Failed" ? save.failure : null),
		hstack(h, { gap: "3", justify: "between", wrap: true }, [
			gatedControl(h, model, "status_pages:edit", (isDisabled) =>
				removeButton(h, {
					isDisabled,
					onClick: Message.ClickedDeleteComponent({ componentId: component.id }),
				}),
			),
			saveIndicator(h, save),
		]),
	]
}

const REORDER_HINT_ID = "status-page-reorder-hint"

/** The components under each group's head, in page order, ungrouped last. */
const componentListView = (h: H, model: Model): Html =>
	componentList(h, {
		grants: model,
		isReorderBusy: model.isSavingOrder,
		hintId: REORDER_HINT_ID,
		onMoveGroup: (group, offset) => Message.PressedMoveGroup({ group, offset }),
		groupGripId,
		leading:
			model.orderFailure === null
				? []
				: [
						h.div(
							[h.Key("order-failure"), h.Class("p-4 pb-0")],
							failureAlert(h, "Couldn't save the order", model.orderFailure),
						),
					],
		rows: Arr.map(groupedOrder(listedComponentsOf(model)), (component) => {
			const isOpen = model.panel?._tag === "Component" && model.panel.componentId === component.id
			return {
				key: component.id,
				name: component.name,
				group: component.group,
				status: componentStatus(component, monitorsOf(model), incidentsOf(model)),
				source: sourceLine(monitorsOf(model), component.monitor_id),
				isOpen,
				rowId: componentRowId(component.id),
				gripId: componentGripId(component.id),
				onToggle: Message.ClickedComponent({ componentId: component.id }),
				onMove: (offset) => Message.PressedMoveComponent({ componentId: component.id, offset }),
				body: isOpen
					? [
							vstack(
								h,
								{
									gap: "4",
									attributes:
										model.revealComponentId === component.id
											? [h.OnMount(RevealOpenComponent())]
											: [],
								},
								componentBody(h, model, component),
							),
						]
					: [],
			}
		}),
	})

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
			actions: gatedControl(h, model, "status_pages:edit", (isDisabled) =>
				button(
					h,
					{
						size: "sm",
						// Reopened mid-save, Add would list the monitors being added again.
						isLoading: model.isAddingComponents,
						isDisabled,
						attributes: [h.OnClick(Message.ClickedAddComponent())],
					},
					[icon(h, "PlusIcon"), "Add monitors"],
				),
			),
		},
		[
			componentsOf(model).length === 0
				? typography(h, { size: "sm", tone: "muted", as: "p", className: "p-4" }, [
						canManage(model)
							? "Nothing yet. Add a monitor and visitors see its status and uptime."
							: "No monitors on this page yet.",
					])
				: componentListView(h, model),
		],
	)
