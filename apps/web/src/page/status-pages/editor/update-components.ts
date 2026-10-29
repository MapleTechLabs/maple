import type { StatusPageComponentId } from "@maple/domain"
import type { V2StatusPageComponent, V2UptimeMonitor } from "@maple/domain/http/v2"
import { Option, Result } from "effect"
import { AsyncData } from "foldkit"
import type { LoadFailure } from "../../../data/load-failure"
import * as Dialog from "../../../ui/dialog"
import type { PageContext } from "../../contract"
import {
	type ComponentTextField,
	componentFormOf,
	componentPayload,
	type ComponentForm,
} from "../shared/form"
import {
	draftComponents,
	hasRowIssues,
	monitorCreated,
	monitorFailed,
	type PickerMessage,
	seedPicker,
	updatePicker,
} from "../shared/picker"
import { rowNameId } from "../shared/picker-view"
import {
	AddComponents,
	CreateEditorMonitor,
	DeleteComponent,
	FocusEditorElement,
	ReorderComponents,
	SaveComponent,
} from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import {
	chain,
	componentsOf,
	errorToast,
	liftDialog,
	monitorsOf,
	readComponents,
	readPage,
	type Return,
	toast,
} from "./reads"

// Components in the side panel: saved as you go, removed behind a confirm, moved in the list,
// and added from the same checklist the builder uses.

export const PANEL_TITLE_ID = "status-page-panel-title"
export const ADD_PICKER_ID = "status-page-add"

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

/** Opens the panel and moves focus to its title, so a screen reader lands in it. */
export const focusPanel = (model: Model): Return => ({
	model,
	commands: [FocusEditorElement({ id: PANEL_TITLE_ID })],
})

export const selectComponent = (model: Model, componentId: StatusPageComponentId): Return => {
	const component = componentsOf(model).find((row) => row.id === componentId)
	return component === undefined
		? { model }
		: focusPanel({
				...model,
				panel: { _tag: "Component", componentId },
				componentForm: componentFormOf(component),
				componentSave: "idle",
				componentFailure: null,
			})
}

export const changeComponent = (model: Model, field: ComponentTextField, value: string): Return => ({
	model: { ...model, componentForm: { ...model.componentForm, [field]: value } },
})

const isSame = (form: ComponentForm, component: V2StatusPageComponent): boolean =>
	JSON.stringify(componentPayload(form)) === JSON.stringify(componentPayload(componentFormOf(component)))

/** Saves the form when it differs from the component; a save in flight re-commits when it lands. */
export const commitComponent = (model: Model): Return => {
	const form = model.componentForm
	const saved = componentsOf(model).find((row) => row.id === form.editingId)
	if (
		!model.isAdmin ||
		model.pageId === null ||
		saved === undefined ||
		model.componentSave === "saving" ||
		form.name.trim() === "" ||
		isSame(form, saved)
	)
		return { model }
	return {
		model: { ...model, componentSave: "saving", componentFailure: null },
		commands: [
			SaveComponent({ pageId: model.pageId, componentId: saved.id, payload: componentPayload(form) }),
		],
	}
}

/** Components and the page revision change together: both are read again. */
const reread = (model: Model, context: PageContext): Return =>
	chain(model, readComponents(context, "Supersede"), readPage(context, "Supersede"))

export const savedComponent = (
	model: Model,
	result: Result.Result<V2StatusPageComponent, LoadFailure>,
	context: PageContext,
): Return =>
	Result.match(result, {
		onSuccess: (component): Return => {
			// The saved row replaces the listed one at once, so the next commit diffs against it.
			const next: Model = {
				...model,
				componentSave: "saved",
				components: {
					...model.components,
					data: AsyncData.map(model.components.data, (rows) =>
						rows.map((row) => (row.id === component.id ? component : row)),
					),
				},
			}
			return chain(next, (settled) => reread(settled, context), commitComponent)
		},
		onFailure: (componentFailure): Return => ({
			model: { ...model, componentSave: "failed", componentFailure },
		}),
	})

/** The list with `componentId` moved by `offset`, or `null` when it cannot move that way. */
export const moved = <A extends { readonly id: StatusPageComponentId }>(
	components: ReadonlyArray<A>,
	componentId: StatusPageComponentId,
	offset: number,
): ReadonlyArray<A> | null => {
	const from = components.findIndex((component) => component.id === componentId)
	const to = from + offset
	const item = components[from]
	if (from < 0 || to < 0 || to >= components.length || item === undefined) return null
	const rest = components.filter((_, index) => index !== from)
	return [...rest.slice(0, to), item, ...rest.slice(to)]
}

/** Moves the row at once; the server's order lands with the re-read. */
export const moveComponent = (model: Model, componentId: StatusPageComponentId, offset: number): Return => {
	const next = moved(componentsOf(model), componentId, offset)
	if (model.pageId === null || model.isReordering || next === null || !model.isAdmin) return { model }
	return {
		model: {
			...model,
			isReordering: true,
			components: { ...model.components, data: AsyncData.map(model.components.data, () => next) },
		},
		commands: [
			ReorderComponents({ pageId: model.pageId, componentIds: next.map((component) => component.id) }),
		],
	}
}

export const reordered = (
	model: Model,
	result: Result.Result<ReadonlyArray<V2StatusPageComponent>, LoadFailure>,
	context: PageContext,
): Return => {
	const refreshed = reread({ ...model, isReordering: false }, context)
	return Result.match(result, {
		onSuccess: (): Return => refreshed,
		onFailure: (failure): Return => ({
			...refreshed,
			outMessage: errorToast("Couldn't reorder the components", failure),
		}),
	})
}

export const askDeleteComponent = (model: Model, componentId: StatusPageComponentId): Return =>
	model.isAdmin
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
			const panel =
				closed.model.panel?._tag === "Component" && closed.model.panel.componentId === removedId
					? null
					: closed.model.panel
			const refreshed = reread({ ...closed.model, panel }, context)
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

// ADD

/** The monitors not on the page yet, none picked; a URL or a component by hand join them. */
export const openAdd = (model: Model): Return => {
	if (!model.isAdmin) return { model }
	const used = new Set(
		componentsOf(model).flatMap((component) =>
			component.monitor_id === null ? [] : [component.monitor_id],
		),
	)
	const picker = seedPicker(
		monitorsOf(model).filter((monitor) => !used.has(monitor.id)),
		false,
	)
	return focusPanel({ ...model, panel: { _tag: "Add" }, addPicker: picker, addFailure: null })
}

export const addPickerStep = (model: Model, message: PickerMessage): Return => {
	const step = updatePicker(model.addPicker, message)
	return {
		model: { ...model, addPicker: step.picker },
		commands: [
			...Option.match(step.createMonitor, {
				onNone: () => [],
				onSome: (url) => [CreateEditorMonitor({ url })],
			}),
			...Option.match(step.focusKey, {
				onNone: () => [],
				onSome: (key) => [FocusEditorElement({ id: rowNameId(ADD_PICKER_ID, key) })],
			}),
		],
	}
}

export const addMonitorCreated = (
	model: Model,
	result: Result.Result<V2UptimeMonitor, LoadFailure>,
): Return =>
	Result.match(result, {
		onSuccess: (monitor): Return => ({
			model: {
				...model,
				monitors: {
					...model.monitors,
					data: AsyncData.map(model.monitors.data, (monitors) => [...monitors, monitor]),
				},
				addPicker: monitorCreated(model.addPicker, monitor),
			},
		}),
		onFailure: (failure): Return => ({
			model: { ...model, addPicker: monitorFailed(model.addPicker, failure.message) },
		}),
	})

export const submitAdd = (model: Model): Return => {
	const components = draftComponents(model.addPicker)
	return model.pageId === null ||
		model.isAddingComponents ||
		components.length === 0 ||
		hasRowIssues(model.addPicker)
		? { model }
		: {
				model: { ...model, isAddingComponents: true, addFailure: null },
				commands: [AddComponents({ pageId: model.pageId, components })],
			}
}

export const addedComponents = (
	model: Model,
	result: Result.Result<ReadonlyArray<V2StatusPageComponent>, LoadFailure>,
	context: PageContext,
): Return => {
	const settled = { ...model, isAddingComponents: false }
	return Result.match(result, {
		onSuccess: (added): Return => ({
			...reread({ ...settled, panel: null }, context),
			outMessage: toast(
				"success",
				added.length === 1 ? "Component added" : `${added.length} components added`,
				added.map((component) => component.name).join(", "),
			),
		}),
		// Some may have been created before the failure: the re-read shows which.
		onFailure: (addFailure): Return => reread({ ...settled, addFailure }, context),
	})
}
