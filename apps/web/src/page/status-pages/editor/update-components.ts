import { encodeJson } from "@maple/views/data/request-key"
import type { StatusPageComponentId } from "@maple/domain"
import type { V2StatusPageComponent, V2UptimeMonitor } from "@maple/domain/http/v2"
import { Option, Result, Array as Arr, String as Str } from "effect"
import { AsyncData } from "foldkit"
import type { LoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
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
import { canManage, type Model } from "./model"
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

// Components under Settings > Monitors: opened in place, saved as you go, removed behind a
// confirm, moved within their group, and added from the same checklist the builder uses.

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

/**
 * Opens the component in its row, which scrolls itself into view as it mounts. The one open before
 * saves what was typed first, or queues it behind a save in flight.
 */
export const selectComponent = (model: Model, componentId: StatusPageComponentId): Return => {
	const found = Arr.findFirst(componentsOf(model), (row) => row.id === componentId)
	if (Option.isNone(found)) return { model }
	return chain(model, commitComponent, (next) => ({
		model: {
			...next,
			panel: { _tag: "Component", componentId },
			componentForm: componentFormOf(found.value),
			revealComponentId: null,
		},
	}))
}

export const changeComponent = (model: Model, field: ComponentTextField, value: string): Return => ({
	model: { ...model, componentForm: { ...model.componentForm, [field]: value } },
})

const isSame = (form: ComponentForm, component: V2StatusPageComponent): boolean =>
	encodeJson(componentPayload(form)) === encodeJson(componentPayload(componentFormOf(component)))

const withoutQueued = (model: Model, componentId: string | null): Model => ({
	...model,
	queuedComponentForms: Arr.filter(model.queuedComponentForms, (form) => form.editingId !== componentId),
})

/**
 * Saves `form` when it differs from its component. With a save in flight it waits in the queue,
 * replacing any older form of the same component.
 */
const commitForm = (model: Model, form: ComponentForm): Return => {
	const found = Arr.findFirst(componentsOf(model), (row) => row.id === form.editingId)
	if (
		!canManage(model) ||
		model.pageId === null ||
		Option.isNone(found) ||
		Str.trim(form.name) === "" ||
		isSame(form, found.value)
	)
		return { model: withoutQueued(model, form.editingId) }
	const rest = withoutQueued(model, form.editingId)
	if (model.componentSave?._tag === "Saving")
		return { model: { ...rest, queuedComponentForms: [...rest.queuedComponentForms, form] } }
	return {
		model: { ...rest, componentSave: { _tag: "Saving", componentId: found.value.id } },
		commands: [
			SaveComponent({
				pageId: model.pageId,
				componentId: found.value.id,
				payload: componentPayload(form),
			}),
		],
	}
}

/** Saves the open component's form; nothing while no component is open. */
export const commitComponent = (model: Model): Return =>
	model.panel?._tag === "Component" && model.panel.componentId === model.componentForm.editingId
		? commitForm(model, model.componentForm)
		: { model }

/** The next queued form, once the save before it landed. */
const commitQueued = (model: Model): Return =>
	Option.match(Arr.head(model.queuedComponentForms), {
		onNone: () => ({ model }),
		onSome: (form) => commitForm(model, form),
	})

/** Components and the page revision change together: both are read again. */
const reread = (model: Model, context: PageContext): Return =>
	chain(model, readComponents(context, "Supersede"), readPage(context, "Supersede"))

/**
 * A save landed for the component it was sent for. A refused one is shown on that component's row,
 * and its queued edits are dropped rather than sent behind its back; other components' queue on.
 */
export const savedComponent = (
	model: Model,
	result: Result.Result<V2StatusPageComponent, LoadFailure>,
	context: PageContext,
): Return => {
	const save = model.componentSave
	if (save?._tag !== "Saving") return { model }
	return Result.match(result, {
		onSuccess: (component): Return => {
			// The saved row replaces the listed one at once, so the next commit diffs against it.
			const next: Model = {
				...model,
				componentSave: { _tag: "Saved", componentId: save.componentId },
				components: {
					...model.components,
					data: AsyncData.map(model.components.data, (rows) =>
						Arr.map(rows, (row) => (row.id === component.id ? component : row)),
					),
				},
			}
			return chain(next, (settled) => reread(settled, context), commitQueued)
		},
		onFailure: (failure): Return =>
			commitQueued(
				withoutQueued(
					{ ...model, componentSave: { _tag: "Failed", componentId: save.componentId, failure } },
					save.componentId,
				),
			),
	})
}

type Groupable = { readonly id: StatusPageComponentId; readonly group: string | null }

/**
 * The components as the public page lists them: each group, ungrouped ones too, where its first
 * member is, then its members in page order.
 */
export const groupedOrder = <A extends Groupable>(components: ReadonlyArray<A>): ReadonlyArray<A> =>
	Arr.flatMap(Arr.dedupe(Arr.map(components, (component) => component.group)), (group) =>
		Arr.filter(components, (component) => component.group === group),
	)

/** A component's place among its group's members; `null` when it is not listed. */
const groupIndexOf = <A extends Groupable>(
	components: ReadonlyArray<A>,
	componentId: StatusPageComponentId,
): number | null =>
	Option.getOrNull(
		Option.map(
			Arr.findFirst(components, (component) => component.id === componentId),
			(item) => Arr.filter(components, (component) => component.group === item.group).indexOf(item),
		),
	)

/**
 * The list with `componentId` at `index` among its group's members (clamped to the group), the
 * members between shifting a slot; other groups keep their places. `null` when it is not listed
 * or already there.
 */
export const moved = <A extends Groupable>(
	components: ReadonlyArray<A>,
	componentId: StatusPageComponentId,
	index: number,
): ReadonlyArray<A> | null => {
	const item = Arr.findFirst(components, (component) => component.id === componentId)
	if (Option.isNone(item)) return null
	const group = Arr.filter(components, (component) => component.group === item.value.group)
	const to = Math.min(Math.max(index, 0), group.length - 1)
	if (to === group.indexOf(item.value)) return null
	const rest = Arr.filter(group, (component) => component.id !== componentId)
	const order = [...Arr.take(rest, to), item.value, ...Arr.drop(rest, to)]
	// The group's slots in page order, filled with its new order.
	return Arr.mapAccum(components, 0, (rank, component): [number, A] =>
		component.group === item.value.group ? [rank + 1, order[rank] ?? component] : [rank, component],
	)[1]
}

/** Moves the row to `index` in its group at once; the server's order lands with the re-read. */
export const moveComponent = (model: Model, componentId: StatusPageComponentId, index: number): Return => {
	const next = moved(componentsOf(model), componentId, index)
	if (model.pageId === null || model.isReordering || next === null || !canManage(model)) return { model }
	return {
		model: {
			...model,
			isReordering: true,
			components: { ...model.components, data: AsyncData.map(model.components.data, () => next) },
		},
		commands: [
			ReorderComponents({
				pageId: model.pageId,
				componentIds: Arr.map(next, (component) => component.id),
			}),
		],
	}
}

/** An arrow key on the grip: one slot up (-1) or down (1), focus kept on the moved row's grip. */
export const nudgeComponent = (model: Model, componentId: StatusPageComponentId, offset: number): Return => {
	const from = groupIndexOf(componentsOf(model), componentId)
	if (from === null) return { model }
	const next = moveComponent(model, componentId, from + offset)
	return next.commands === undefined
		? next
		: { ...next, commands: [...next.commands, FocusEditorElement({ id: componentGripId(componentId) })] }
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
			const panel =
				closed.model.panel?._tag === "Component" && closed.model.panel.componentId === removedId
					? null
					: closed.model.panel
			const refreshed = reread(withoutQueued({ ...closed.model, panel }, removedId), context)
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
	return { model: { ...model, panel: { _tag: "Add", session }, addSession: session, addPicker: picker } }
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
