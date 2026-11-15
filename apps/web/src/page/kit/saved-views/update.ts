import { SAVED_VIEW_NAME_MAX_LENGTH, type SavedViewVisibility } from "@maple/domain/saved-views"
import * as Dialog from "@maple/views/ui/dialog"
import * as Menu from "@maple/views/ui/menu"
import { Array as Arr, Option, Order, Result, String as Str } from "effect"
import { Command, type Update } from "foldkit"
import type { Resources } from "../../../platform/resources"
import { CreateView, DeleteView, FetchViews, RenameView, SetViewVisibility, UpdateViewState } from "./command"
import { activeViewOf, type Form, Message, type Model, OutMessage, type SavedView } from "./model"
import type { Explorer } from "./state"

// The Views control's steps: what a menu pick does, the save and rename form, and the writes they send.

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>

/** The menu's items, by value. A view's item is `view:<id>`. */
export const ITEM = {
	save: "save",
	saveAsNew: "save-as-new",
	update: "update",
	discard: "discard",
	rename: "rename",
	share: "share",
	delete: "delete",
	retry: "retry",
} as const
const VIEW_PREFIX = "view:"
export const viewItem = (id: string): string => `${VIEW_PREFIX}${id}`

// The API's order: the viewer's own first, then shared ones, each by name.
const listOrder: Order.Order<SavedView> = Order.combine(
	Order.mapInput(Order.Boolean, (view: SavedView) => !view.isOwner),
	Order.mapInput(Order.String, (view: SavedView) => Str.toLowerCase(view.name)),
)

const withView = (model: Model, view: SavedView): Model => ({
	...model,
	revision: model.revision + 1,
	views: Arr.sort([...Arr.filter(model.views ?? [], (other) => other.id !== view.id), view], listOrder),
})

const isListed = (model: Model, viewId: string): boolean =>
	Arr.some(model.views ?? [], (view) => view.id === viewId)

// A write's answer for a view deleted while it was out must not put the view back.
const withWrittenView = (model: Model, view: SavedView): Model =>
	isListed(model, view.id) ? withView(model, view) : model

/** A refused share toggle: its row goes back to what it was, whatever a refresh showed meanwhile. */
const withShareUndone = (model: Model, viewId: string, sharedBefore: SavedViewVisibility): Model => ({
	...model,
	views: Arr.map(model.views ?? [], (view) =>
		view.id === viewId ? { ...view, visibility: sharedBefore } : view,
	),
})

const withCommands = (step: Return, commands: Commands): Return => ({
	...step,
	commands: [...(step.commands ?? []), ...commands],
})

const liftMenu = (model: Model, step: ReturnType<typeof Menu.update>): Return => ({
	model: { ...model, menu: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotMenuMessage({ message })),
})

const liftFormDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, formDialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotFormDialogMessage({ message }),
	),
})

const liftDeleteDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, deleteDialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotDeleteDialogMessage({ message }),
	),
})

/** The list again, unless a read is already out. */
const refetch = (step: Return, explorer: Explorer): Return =>
	step.model.isLoading
		? step
		: withCommands({ ...step, model: { ...step.model, isLoading: true } }, [
				FetchViews({ surface: explorer.surface, revision: step.model.revision }),
			])

/** The list again whatever is out: an earlier read carries an older revision and is dropped. */
const forceRefetch = (model: Model, explorer: Explorer): Return => ({
	model: { ...model, isLoading: true },
	commands: [FetchViews({ surface: explorer.surface, revision: model.revision })],
})

const openForm = (model: Model, form: Form): Return =>
	liftFormDialog({ ...model, form }, Dialog.open(model.formDialog))

const opened = (step: Return, view: SavedView, explorer: Explorer): Return => ({
	...step,
	model: { ...step.model, activeViewId: view.id },
	outMessage: OutMessage.OpenedView({ url: explorer.hrefOf(view.state), search: view.state.search }),
})

const selected = (step: Return, value: string, explorer: Explorer): Return => {
	const model = step.model
	const active = activeViewOf(model, explorer)
	if (Str.startsWith(VIEW_PREFIX)(value)) {
		const id = Str.slice(VIEW_PREFIX.length)(value)
		return Option.match(
			Arr.findFirst(model.views ?? [], (view) => view.id === id),
			{ onNone: () => step, onSome: (view) => opened(step, view, explorer) },
		)
	}
	switch (value) {
		case ITEM.save:
		case ITEM.saveAsNew:
			return withCommands(
				openForm(model, {
					mode: "save",
					viewId: null,
					name: "",
					isShared: false,
					error: null,
					isPending: false,
				}),
				step.commands ?? [],
			)
		case ITEM.update:
			return active === null || !active.isModified || !active.view.isOwner || model.isWriting
				? step
				: withCommands({ ...step, model: { ...model, isWriting: true } }, [
						UpdateViewState({ viewId: active.view.id, state: explorer.current }),
					])
		case ITEM.discard:
			return active === null ? step : opened(step, active.view, explorer)
		case ITEM.rename:
			return active === null || !active.view.isOwner
				? step
				: withCommands(
						openForm(model, {
							mode: "rename",
							viewId: active.view.id,
							name: active.view.name,
							isShared: active.view.visibility === "org",
							error: null,
							isPending: false,
						}),
						step.commands ?? [],
					)
		case ITEM.delete:
			return active === null || !active.view.canDelete
				? step
				: withCommands(
						liftDeleteDialog(
							{ ...model, deleteTarget: active.view, deleteError: null },
							Dialog.open(model.deleteDialog),
						),
						step.commands ?? [],
					)
		case ITEM.retry:
			return refetch(step, explorer)
		default:
			return step
	}
}

/** The share toggle shows at once; a refused write reads the list again. */
const toggledShare = (step: Return, explorer: Explorer): Return => {
	const model = step.model
	const active = activeViewOf(model, explorer)
	if (active === null || !active.view.isOwner || model.isWriting) return step
	const visibility = active.view.visibility === "org" ? "private" : "org"
	return withCommands(
		{ ...step, model: { ...withView(model, { ...active.view, visibility }), isWriting: true } },
		[SetViewVisibility({ viewId: active.view.id, visibility })],
	)
}

const submitted = (model: Model, explorer: Explorer): Return => {
	const name = Str.trim(model.form.name)
	if (name === "" || name.length > SAVED_VIEW_NAME_MAX_LENGTH || model.form.isPending) return { model }
	const pending: Model = { ...model, form: { ...model.form, error: null, isPending: true } }
	if (model.form.mode === "save") {
		return {
			model: pending,
			commands: [
				CreateView({
					surface: explorer.surface,
					name,
					state: explorer.current,
					visibility: model.form.isShared ? "org" : "private",
				}),
			],
		}
	}
	return Option.match(
		Arr.findFirst(model.views ?? [], (view) => view.id === model.form.viewId),
		{
			// Deleted elsewhere since the dialog opened: nothing left to rename.
			onNone: () => liftFormDialog(model, Dialog.close(model.formDialog)),
			onSome: (view) =>
				view.name === name
					? liftFormDialog(model, Dialog.close(model.formDialog))
					: { model: pending, commands: [RenameView({ viewId: view.id, name })] },
		},
	)
}

/** A write the form was waiting on: the view lands in the list and the dialog closes, or it says why not. */
const settledForm = (
	model: Model,
	result: Result.Result<SavedView, { readonly message: string }>,
	isNowActive: boolean,
): Return =>
	Result.match(result, {
		onSuccess: (view) => {
			const settled = { ...model, form: { ...model.form, isPending: false, error: null } }
			// A new view is added; a renamed one only while it is still listed.
			const next = isNowActive ? withView(settled, view) : withWrittenView(settled, view)
			return liftFormDialog(
				isNowActive ? { ...next, activeViewId: view.id } : next,
				Dialog.close(model.formDialog),
			)
		},
		onFailure: (failure) => ({
			model: { ...model, form: { ...model.form, isPending: false, error: failure.message } },
		}),
	})

export const update = (model: Model, message: Message, explorer: Explorer): Return =>
	Message.match<Return>(message, {
		GotMenuMessage: ({ message: inner }) => {
			const step = Menu.update(model.menu, inner)
			const lifted = liftMenu(model, step)
			// Opening the menu reads the list again: a teammate may have shared a view since.
			const next = !model.menu.isOpen && step.model.isOpen ? refetch(lifted, explorer) : lifted
			const out = step.outMessage
			if (out === undefined) return next
			if (out._tag === "SelectedItem") return selected(next, out.value, explorer)
			return out._tag === "ToggledCheckbox" && out.value === ITEM.share
				? toggledShare(next, explorer)
				: next
		},
		GotFormDialogMessage: ({ message: inner }) =>
			liftFormDialog(model, Dialog.update(model.formDialog, inner)),
		GotDeleteDialogMessage: ({ message: inner }) =>
			liftDeleteDialog(model, Dialog.update(model.deleteDialog, inner)),
		CompletedFetchViews: ({ revision, result }) =>
			// Sent before a save, share or delete here: its rows are older than the list on screen.
			revision !== model.revision
				? { model: { ...model, isLoading: false } }
				: Result.match(result, {
						onSuccess: (views) => ({
							model: { ...model, views, loadFailure: null, isLoading: false },
						}),
						// A failed refresh keeps the list it had.
						onFailure: (failure) => ({
							model: { ...model, loadFailure: failure, isLoading: false },
						}),
					}),
		ChangedName: ({ value }) => ({
			model: { ...model, form: { ...model.form, name: value, error: null } },
		}),
		ToggledShared: () => ({
			model: { ...model, form: { ...model.form, isShared: !model.form.isShared } },
		}),
		SubmittedForm: () => submitted(model, explorer),
		CompletedCreateView: ({ result }) => settledForm(model, result, true),
		CompletedRenameView: ({ result }) => settledForm(model, result, false),
		CompletedUpdateView: ({ action, viewId, sharedBefore, result }) =>
			Result.match(result, {
				// The page's view is left as it is: the person may have picked another while this was out.
				onSuccess: (view) => ({ model: withWrittenView({ ...model, isWriting: false }, view) }),
				onFailure: (failure) => ({
					...forceRefetch(
						sharedBefore === null
							? { ...model, isWriting: false }
							: withShareUndone({ ...model, isWriting: false }, viewId, sharedBefore),
						explorer,
					),
					outMessage: OutMessage.RequestedToast({
						type: "error",
						title: action === "update" ? "Couldn't update view" : "Couldn't change sharing",
						description: failure.message,
					}),
				}),
			}),
		ConfirmedDelete: () =>
			model.deleteTarget === null || model.isDeleting
				? { model }
				: {
						model: { ...model, isDeleting: true, deleteError: null },
						commands: [DeleteView({ viewId: model.deleteTarget.id })],
					},
		CompletedDeleteView: ({ viewId, result }) =>
			Result.match(result, {
				onSuccess: () =>
					liftDeleteDialog(
						{
							...model,
							isDeleting: false,
							revision: model.revision + 1,
							views: Arr.filter(model.views ?? [], (view) => view.id !== viewId),
							activeViewId: model.activeViewId === viewId ? null : model.activeViewId,
						},
						Dialog.close(model.deleteDialog),
					),
				onFailure: (failure) => ({
					model: { ...model, isDeleting: false, deleteError: failure.message },
				}),
			}),
	})
