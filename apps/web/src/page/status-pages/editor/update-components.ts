import { encodeJson } from "@maple/views/data/request-key"
import type { StatusPageComponentId } from "@maple/domain"
import type { V2StatusPageComponent, V2UptimeMonitor } from "@maple/domain/http/v2"
import { Option, Result, Array as Arr, String as Str } from "effect"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import type { LoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import type { PageContext } from "../../contract"
import {
	type ComponentTextField,
	componentFormOf,
	componentPayload,
	type ComponentForm,
	emptyComponentForm,
} from "../shared/form"
import { groupIndexOf, groupOrder, moved, movedGroup } from "../shared/component-order"
import type * as Combobox from "@maple/views/ui/combobox"
import { updateGroupPicker } from "../shared/group-picker"
import {
	draftComponents,
	hasRowIssues,
	monitorCreated,
	monitorFailed,
	type PickerMessage,
	seedPicker,
	updatePicker,
} from "../shared/picker"
import {
	AddComponents,
	CreateEditorMonitor,
	DeleteComponent,
	FocusEditorElement,
	ReorderComponents,
	SaveComponent,
	TrackMonitorCreated,
} from "./command"
import { Message } from "./message"
import { canManage, type ComponentLeave, type Model } from "./model"
import {
	chain,
	componentsOf,
	errorToast,
	listedComponentsOf,
	liftDialog,
	monitorsOf,
	readComponents,
	readPage,
	type Return,
	toast,
} from "./reads"

// Components under Settings > Monitors: opened in place and saved from the save bar (leaving
// unsaved edits asks first), removed behind a confirm, moved within their group (the order saves
// from the same bar), and added from the same checklist the builder uses.

export const ADD_PICKER_ID = "status-page-add"

/** A component's row in the Monitors list: the button that opens and closes it. */
export const componentRowId = (componentId: StatusPageComponentId): string =>
	`status-page-item-${componentId}`

/** A component's drag grip in the Monitors list. */
export const componentGripId = (componentId: StatusPageComponentId): string =>
	`status-page-grip-${componentId}`

export const deleteComponentDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => {
	const lifted = liftDialog(
		model,
		step,
		(next, deleteComponentDialog) => ({ ...next, deleteComponentDialog }),
		(message) => Message.GotDeleteComponentDialogMessage({ message }),
	)
	return step.outMessage?._tag === "Closed"
		? { ...lifted, model: { ...lifted.model, confirmDeleteComponentId: null } }
		: lifted
}

const isSame = (form: ComponentForm, other: ComponentForm): boolean =>
	encodeJson(componentPayload(form)) === encodeJson(componentPayload(other))

/** The listed component the open form edits, while the form differs from it. */
export const unsavedComponent = (model: Model): Option.Option<V2StatusPageComponent> =>
	Arr.findFirst(
		componentsOf(model),
		(row) =>
			row.id === model.componentForm.editingId && !isSame(model.componentForm, componentFormOf(row)),
	)

/** Unsaved edits that leaving would lose: not the form a save in flight is sending. */
const editsAtRisk = (model: Model): Option.Option<V2StatusPageComponent> =>
	Option.filter(
		unsavedComponent(model),
		() =>
			model.componentSave?._tag !== "Saving" || !isSame(model.componentSave.form, model.componentForm),
	)

/**
 * Opens the component in its row; a reveal scrolls the row into view as it mounts. Its unsaved
 * edits, left there by a tab switch, open with it.
 */
const openComponent = (model: Model, componentId: StatusPageComponentId, isRevealed: boolean): Return =>
	Option.match(
		Arr.findFirst(componentsOf(model), (row) => row.id === componentId),
		{
			onNone: () => ({ model }),
			onSome: (component) => ({
				model: {
					...model,
					panel: { _tag: "Component", componentId },
					componentForm:
						model.componentForm.editingId === componentId
							? model.componentForm
							: componentFormOf(component),
					revealComponentId: isRevealed ? componentId : null,
				},
			}),
		},
	)

/** Closing a component hands focus back to its row. */
const closeComponent = (model: Model): Return =>
	model.panel?._tag === "Component"
		? {
				model: { ...model, panel: null, componentForm: emptyComponentForm },
				commands: [FocusEditorElement({ id: componentRowId(model.panel.componentId) })],
			}
		: { model }

const leave = (model: Model, action: ComponentLeave): Return => {
	switch (action._tag) {
		case "Open":
			return openComponent(model, action.componentId, action.isRevealed)
		case "Close":
			return closeComponent(model)
		case "Add":
			return openAdd(model)
	}
}

export const discardComponentDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return =>
	liftDialog(
		model,
		step,
		(next, discardComponentDialog) => ({ ...next, discardComponentDialog }),
		(message) => Message.GotDiscardComponentDialogMessage({ message }),
	)

/**
 * Opens another component, closes this one or opens Add: at once while nothing typed would be
 * lost, else once the edits are discarded behind a confirm. Nothing saves on the way out.
 */
export const leaveComponent = (model: Model, action: ComponentLeave): Return =>
	Option.match(
		Option.filter(
			editsAtRisk(model),
			(component) => action._tag !== "Open" || action.componentId !== component.id,
		),
		{
			onNone: () => leave(model, action),
			onSome: (component) =>
				discardComponentDialog(
					{ ...model, pendingLeave: { componentId: component.id, action } },
					Dialog.open(model.discardComponentDialog),
				),
		},
	)

/** Discard changes: the edits go and the leave they held up goes ahead. */
export const confirmDiscardComponent = (model: Model): Return => {
	const pending = model.pendingLeave
	if (pending === null || !model.discardComponentDialog.isOpen) return { model }
	return chain(
		model,
		(next) => discardComponentDialog(next, Dialog.close(next.discardComponentDialog)),
		(next) => leave({ ...next, componentForm: emptyComponentForm }, pending.action),
	)
}

export const changeComponent = (model: Model, field: ComponentTextField, value: string): Return =>
	editComponent(model, { ...model.componentForm, [field]: value })

/** The Group dropdown: picking or creating a group sets the open component's, waiting on Save. */
export const groupPickerStep = (model: Model, message: Combobox.Message): Return => {
	const step = updateGroupPicker(model.groupPicker, message)
	const next = Option.match(step.picked, {
		onNone: () => ({ model: { ...model, groupPicker: step.picker } }),
		onSome: (group) => changeComponent({ ...model, groupPicker: step.picker }, "group", group),
	})
	return {
		...next,
		commands: FoldkitCommand.mapMessages(step.commands, (child) =>
			Message.GotGroupPickerMessage({ message: child }),
		),
	}
}

export const toggleComponentUptime = (model: Model): Return =>
	editComponent(model, { ...model.componentForm, showUptime: !model.componentForm.showUptime })

/** An edit only changes the form; a "Saved" from before it no longer holds. */
const editComponent = (model: Model, componentForm: ComponentForm): Return => ({
	model: {
		...model,
		componentForm,
		componentSave: model.componentSave?._tag === "Saved" ? null : model.componentSave,
	},
})

/** One PATCH of the whole component, while it differs, has a name and no save is in flight. */
const saveComponent = (model: Model): Return => {
	const found = unsavedComponent(model)
	if (
		!canManage(model) ||
		model.pageId === null ||
		Option.isNone(found) ||
		Str.trim(model.componentForm.name) === "" ||
		model.componentSave?._tag === "Saving"
	)
		return { model }
	return {
		model: {
			...model,
			componentSave: { _tag: "Saving", componentId: found.value.id, form: model.componentForm },
		},
		commands: [
			SaveComponent({
				pageId: model.pageId,
				componentId: found.value.id,
				payload: componentPayload(model.componentForm),
			}),
		],
	}
}

/** The form goes back to the saved component, and a refused save's alert with it. */
const discardComponent = (model: Model): Return =>
	Option.match(unsavedComponent(model), {
		onNone: () => ({ model }),
		onSome: (component) => ({
			model: {
				...model,
				componentForm: componentFormOf(component),
				componentSave:
					model.componentSave?._tag === "Failed" && model.componentSave.componentId === component.id
						? null
						: model.componentSave,
			},
		}),
	})

/** Components and the page revision change together: both are read again. */
const reread = (model: Model, context: PageContext): Return =>
	chain(model, readComponents(context, "Supersede"), readPage(context, "Supersede"))

/**
 * A save landed for the component it was sent for. The saved row replaces the listed one at once,
 * so the save bar goes unless more was typed meanwhile. A refused one is shown on that component's
 * row, its edits kept.
 */
export const savedComponent = (
	model: Model,
	result: Result.Result<V2StatusPageComponent, LoadFailure>,
	context: PageContext,
): Return => {
	const save = model.componentSave
	if (save?._tag !== "Saving") return { model }
	return Result.match(result, {
		onSuccess: (component): Return =>
			reread(
				{
					...model,
					componentSave: { _tag: "Saved", componentId: save.componentId },
					components: {
						...model.components,
						data: AsyncData.map(model.components.data, (rows) =>
							Arr.map(rows, (row) => (row.id === component.id ? component : row)),
						),
					},
				},
				context,
			),
		onFailure: (failure): Return => ({
			model: { ...model, componentSave: { _tag: "Failed", componentId: save.componentId, failure } },
		}),
	})
}

/** The listed order with the row at `index` in its group, waiting on Save; `null` when nothing moves. */
const reorder = (model: Model, componentId: StatusPageComponentId, index: number): Model | null => {
	const next = moved(listedComponentsOf(model), componentId, index)
	return next === null || model.isSavingOrder || !canManage(model)
		? null
		: { ...model, pendingOrder: Arr.map(next, (component) => component.id) }
}

/** A drop: the row takes the slot it was let go over, and the order waits on Save. */
export const moveComponent = (model: Model, componentId: StatusPageComponentId, index: number): Return => ({
	model: reorder(model, componentId, index) ?? model,
})

/** An arrow key on the grip: one slot up (-1) or down (1), focus kept on the moved row's grip. */
export const nudgeComponent = (model: Model, componentId: StatusPageComponentId, offset: number): Return => {
	const from = groupIndexOf(listedComponentsOf(model), componentId)
	const next = from === null ? null : reorder(model, componentId, from + offset)
	return next === null
		? { model }
		: { model: next, commands: [FocusEditorElement({ id: componentGripId(componentId) })] }
}

/** A group's drag grip in the Monitors list. */
export const groupGripId = (group: string | null): string =>
	`status-page-group-grip-${group === null ? "none" : encodeURIComponent(group)}`

/** The listed order with `group` at `index` among the groups, waiting on Save; `null` when nothing moves. */
const reorderGroup = (model: Model, group: string | null, index: number): Model | null => {
	const next = movedGroup(listedComponentsOf(model), group, index)
	return next === null || model.isSavingOrder || !canManage(model)
		? null
		: { ...model, pendingOrder: Arr.map(next, (component) => component.id) }
}

/** A group's drop: its components take the group's new place together. */
export const moveGroup = (model: Model, group: string | null, index: number): Return => ({
	model: reorderGroup(model, group, index) ?? model,
})

/** An arrow key on a group's grip: one place up or down, focus kept on its grip. */
export const nudgeGroup = (model: Model, group: string | null, offset: number): Return => {
	const from = groupOrder(listedComponentsOf(model)).indexOf(group)
	const next = from === -1 ? null : reorderGroup(model, group, from + offset)
	return next === null
		? { model }
		: { model: next, commands: [FocusEditorElement({ id: groupGripId(group) })] }
}

/** The ids Save sends as the new order, while the listed order differs from the saved one. */
export const unsavedOrder = (model: Model): Option.Option<ReadonlyArray<StatusPageComponentId>> => {
	const saved = componentsOf(model)
	const listed = listedComponentsOf(model)
	return Arr.every(listed, (component, index) => component.id === saved[index]?.id)
		? Option.none()
		: Option.some(Arr.map(listed, (component) => component.id))
}

/** The whole order as one reorder, while it differs from the saved one and no order save is in flight. */
const saveOrder = (model: Model): Return => {
	const order = unsavedOrder(model)
	return !canManage(model) || model.pageId === null || Option.isNone(order) || model.isSavingOrder
		? { model }
		: {
				model: { ...model, isSavingOrder: true, orderFailure: null },
				commands: [ReorderComponents({ pageId: model.pageId, componentIds: order.value })],
			}
}

/** Save under Monitors: a moved order and the open component's edits, each its own write. */
export const saveMonitors = (model: Model): Return => chain(model, saveOrder, saveComponent)

/** Discard under Monitors: the saved order and the saved component come back. */
export const discardMonitors = (model: Model): Return =>
	discardComponent({ ...model, pendingOrder: null, orderFailure: null })

/**
 * The order saved: the list keeps it as the saved order until the re-read brings the server's. A
 * refused one stays pending with why.
 */
export const reordered = (
	model: Model,
	result: Result.Result<ReadonlyArray<V2StatusPageComponent>, LoadFailure>,
	context: PageContext,
): Return =>
	Result.match(result, {
		onSuccess: (): Return =>
			reread(
				{
					...model,
					isSavingOrder: false,
					pendingOrder: null,
					components: {
						...model.components,
						data: AsyncData.map(model.components.data, () => listedComponentsOf(model)),
					},
				},
				context,
			),
		onFailure: (failure): Return => ({
			model: { ...model, isSavingOrder: false, orderFailure: failure },
		}),
	})

export const askDeleteComponent = (model: Model, componentId: StatusPageComponentId): Return =>
	canManage(model)
		? deleteComponentDialog(
				{ ...model, confirmDeleteComponentId: componentId },
				Dialog.open(model.deleteComponentDialog),
			)
		: { model }

export const confirmDeleteComponent = (model: Model): Return => {
	const id = model.confirmDeleteComponentId
	return model.pageId === null || id === null || model.isDeletingComponent
		? { model }
		: {
				model: { ...model, isDeletingComponent: true },
				commands: [DeleteComponent({ pageId: model.pageId, componentId: id })],
			}
}

export const deletedComponent = (
	model: Model,
	result: Result.Result<void, LoadFailure>,
	context: PageContext,
): Return => {
	const settled = { ...model, isDeletingComponent: false }
	return Result.match(result, {
		onSuccess: (): Return => {
			const closed = deleteComponentDialog(settled, Dialog.close(settled.deleteComponentDialog))
			const removedId = model.confirmDeleteComponentId
			const isOpen =
				closed.model.panel?._tag === "Component" && closed.model.panel.componentId === removedId
			const refreshed = reread(
				isOpen ? { ...closed.model, panel: null, componentForm: emptyComponentForm } : closed.model,
				context,
			)
			return {
				model: refreshed.model,
				commands: [...(closed.commands ?? []), ...(refreshed.commands ?? [])],
				outMessage: toast("success", "Component removed"),
			}
		},
		onFailure: (failure): Return => ({
			model: settled,
			outMessage: errorToast("Couldn't remove the component", failure),
		}),
	})
}

/** The monitors not on the page yet, none picked; a URL or a component by hand join them. */
export const openAdd = (model: Model): Return => {
	if (!canManage(model) || model.isAddingComponents) return { model }
	const used = new Set(
		Arr.flatMap(componentsOf(model), (component) =>
			component.monitor_id === null ? [] : [component.monitor_id],
		),
	)
	const picker = seedPicker(
		Arr.filter(monitorsOf(model), (monitor) => !used.has(monitor.id)),
		false,
	)
	const session = model.addSession + 1
	return {
		model: {
			...model,
			panel: { _tag: "Add", session },
			addSession: session,
			addPicker: picker,
			componentForm: emptyComponentForm,
		},
	}
}

/** Whether the Add panel open now is the one `session` started in. */
const isAddSession = (model: Model, session: number): boolean =>
	model.panel?._tag === "Add" && model.panel.session === session

export const addPickerStep = (model: Model, message: PickerMessage): Return => {
	const step = updatePicker(model.addPicker, message)
	return {
		model: { ...model, addPicker: step.picker },
		commands: [
			...Option.match(step.createMonitor, {
				onNone: () => [],
				onSome: (url) => [CreateEditorMonitor({ session: model.addSession, url })],
			}),
		],
	}
}

/** A monitored URL goes straight onto the page, with any rows already ticked beside it. */
export const addMonitorCreated = (
	model: Model,
	session: number,
	result: Result.Result<V2UptimeMonitor, LoadFailure>,
): Return =>
	Result.match(result, {
		onSuccess: (monitor): Return => {
			const withMonitor = {
				...model,
				monitors: {
					...model.monitors,
					data: AsyncData.map(model.monitors.data, (monitors) => [...monitors, monitor]),
				},
			}
			const track = TrackMonitorCreated({ kind: monitor.kind })
			// Closed or reopened while the monitor was created: keep the monitor, touch nothing else.
			if (!isAddSession(model, session)) return { model: withMonitor, commands: [track] }
			const next = submitAdd({ ...withMonitor, addPicker: monitorCreated(model.addPicker, monitor) })
			return { ...next, commands: [...(next.commands ?? []), track] }
		},
		onFailure: (failure): Return =>
			isAddSession(model, session)
				? { model: { ...model, addPicker: monitorFailed(model.addPicker, failure.message) } }
				: { model },
	})

export const submitAdd = (model: Model): Return => {
	const components = draftComponents(model.addPicker)
	return model.pageId === null ||
		model.isAddingComponents ||
		components.length === 0 ||
		hasRowIssues(model.addPicker)
		? { model }
		: {
				model: { ...model, isAddingComponents: true },
				commands: [AddComponents({ session: model.addSession, pageId: model.pageId, components })],
			}
}

/** Closes the Add sheet it came from; anything opened since stays open. */
const settleAdd = (model: Model, session: number, context: PageContext): Return =>
	reread(
		{ ...model, isAddingComponents: false, panel: isAddSession(model, session) ? null : model.panel },
		context,
	)

export const addedComponents = (
	model: Model,
	session: number,
	result: Result.Result<ReadonlyArray<V2StatusPageComponent>, LoadFailure>,
	context: PageContext,
): Return =>
	Result.match(result, {
		onSuccess: (added): Return => ({
			...settleAdd(model, session, context),
			outMessage: toast(
				"success",
				added.length === 1 ? "Component added" : `${added.length} components added`,
				Arr.join(
					Arr.map(added, (component) => component.name),
					", ",
				),
			),
		}),
		// Some may have been created before the failure, so the panel closes rather than offer a
		// retry that would add them twice; the re-read lists what landed.
		onFailure: (addFailure): Return => ({
			...settleAdd(model, session, context),
			outMessage: errorToast("Couldn't add every component", addFailure),
		}),
	})
