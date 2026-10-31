import type { StatusPageComponentId } from "@maple/domain"
import type { V2StatusPageComponent } from "@maple/domain/http/v2"
import { Result } from "effect"
import { AsyncData } from "foldkit"
import type { LoadFailure } from "../../../../data/load-failure"
import * as Dialog from "../../../../ui/dialog"
import type { PageContext } from "../../../contract"
import { DeleteComponent, ReorderComponents, SaveComponent } from "./command"
import { type ComponentTextField, componentFormOf, componentPayload, emptyComponentForm } from "./form"
import { Message } from "./message"
import type { Model } from "./model"
import {
	chain,
	componentsOf,
	errorToast,
	liftDialog,
	readComponents,
	readPage,
	type Return,
	toast,
} from "./reads"

// The Components tab: add and edit in a dialog, delete behind a confirm, move up and down.

const componentDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return =>
	liftDialog(
		model,
		step,
		(next, componentDialog) => ({ ...next, componentDialog }),
		(message) => Message.GotComponentDialogMessage({ message }),
	)

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

export const openComponent = (model: Model, componentId: StatusPageComponentId | null): Return => {
	const existing = componentsOf(model).find((component) => component.id === componentId)
	const form = existing === undefined ? emptyComponentForm : componentFormOf(existing)
	return componentDialog(
		{ ...model, componentForm: form, componentFailure: null },
		Dialog.open(model.componentDialog),
	)
}

export const changeComponent = (model: Model, field: ComponentTextField, value: string): Return => ({
	model: { ...model, componentForm: { ...model.componentForm, [field]: value } },
})

export const submitComponent = (model: Model): Return =>
	model.pageId === null || model.isSavingComponent || model.componentForm.name.trim() === ""
		? { model }
		: {
				model: { ...model, isSavingComponent: true, componentFailure: null },
				commands: [
					SaveComponent({
						pageId: model.pageId,
						componentId: model.componentForm.editingId,
						payload: componentPayload(model.componentForm),
					}),
				],
			}

/** Components and the page revision change together: both are read again. */
const reread = (model: Model, context: PageContext): Return =>
	chain(model, readComponents(context, "Supersede"), readPage(context, "Supersede"))

export const savedComponent = (
	model: Model,
	result: Result.Result<V2StatusPageComponent, LoadFailure>,
	context: PageContext,
): Return => {
	const settled = { ...model, isSavingComponent: false }
	return Result.match(result, {
		onSuccess: (component): Return => {
			const closed = componentDialog(settled, Dialog.close(settled.componentDialog))
			const refreshed = reread(closed.model, context)
			return {
				model: refreshed.model,
				commands: [...(closed.commands ?? []), ...(refreshed.commands ?? [])],
				outMessage: toast(
					"success",
					model.componentForm.editingId === null ? "Component added" : "Component saved",
					component.name,
				),
			}
		},
		onFailure: (componentFailure): Return => ({ model: { ...settled, componentFailure } }),
	})
}

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
	if (model.pageId === null || model.isReordering || next === null) return { model }
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
	deleteComponentDialog(
		{ ...model, confirmDeleteComponentId: componentId },
		Dialog.open(model.deleteComponentDialog),
	)

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
			const refreshed = reread(closed.model, context)
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

export { componentDialog }
