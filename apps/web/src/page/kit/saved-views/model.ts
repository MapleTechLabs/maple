import { SavedViewResponse } from "@maple/domain/http"
import { SavedViewVisibility } from "@maple/domain/saved-views"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import * as Menu from "@maple/views/ui/menu"
import { ToastType } from "@maple/views/ui/toast"
import { Array as Arr, Option, Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import type { Explorer } from "./state"

// The Views control an explorer embeds (`/logs`, `/traces`, `/metrics`): its menu, the views it
// lists, and the save, rename and delete dialogs.

/** A view as the API lists it, as plain data. */
export const SavedView = Schema.Struct(SavedViewResponse.fields)
export type SavedView = typeof SavedView.Type

/** The save and rename dialog's fields; kept while it closes, so its text does not blank. */
export const Form = Schema.Struct({
	mode: Schema.Literals(["save", "rename"]),
	/** The view a rename is for; `null` while saving a new one. */
	viewId: Schema.NullOr(Schema.String),
	name: Schema.String,
	isShared: Schema.Boolean,
	error: Schema.NullOr(Schema.String),
	isPending: Schema.Boolean,
})
export type Form = typeof Form.Type

export const Model = Schema.Struct({
	menu: Menu.Model,
	/** `null` until the list first answers. */
	views: Schema.NullOr(Schema.Array(SavedView)),
	loadFailure: Schema.NullOr(LoadFailure),
	isLoading: Schema.Boolean,
	/** Bumped by every local change to the list: a read sent before it answers with older rows. */
	revision: Schema.Number,
	/** The view last opened or saved here: it stays the page's view while its params are edited. */
	activeViewId: Schema.NullOr(Schema.String),
	formDialog: Dialog.Model,
	form: Form,
	deleteDialog: Dialog.Model,
	/** The view the delete dialog asks about; kept while it closes. */
	deleteTarget: Schema.NullOr(SavedView),
	isDeleting: Schema.Boolean,
	deleteError: Schema.NullOr(Schema.String),
	/** An "Update view" or a share toggle is in flight: one write at a time. */
	isWriting: Schema.Boolean,
})
export type Model = typeof Model.Type

const NO_FORM: Form = { mode: "save", viewId: null, name: "", isShared: false, error: null, isPending: false }

/** `id` prefixes the control's element ids, one per page. */
export const init = (id: string): Model => ({
	menu: Menu.init(`${id}-menu`),
	views: null,
	loadFailure: null,
	isLoading: true,
	revision: 0,
	activeViewId: null,
	formDialog: Dialog.init(`${id}-form`, "dialog"),
	form: NO_FORM,
	deleteDialog: Dialog.init(`${id}-delete`, "alert-dialog"),
	deleteTarget: null,
	isDeleting: false,
	deleteError: null,
	isWriting: false,
})

const fetched = { revision: Schema.Number, result: Schema.Result(Schema.Array(SavedView), LoadFailure) }
const written = { result: Schema.Result(SavedView, LoadFailure) }

export const Message = defineMessageUnion({
	GotMenuMessage: { message: Menu.Message },
	GotFormDialogMessage: { message: Dialog.Message },
	GotDeleteDialogMessage: { message: Dialog.Message },
	CompletedFetchViews: fetched,
	ChangedName: { value: Schema.String },
	ToggledShared: {},
	SubmittedForm: {},
	CompletedCreateView: written,
	CompletedRenameView: written,
	/**
	 * "Update view" or the share toggle on `viewId`; `action` names which for the failure toast,
	 * and `sharedBefore` is the visibility a refused toggle goes back to.
	 */
	CompletedUpdateView: {
		action: Schema.Literals(["update", "share"]),
		viewId: Schema.String,
		sharedBefore: Schema.NullOr(SavedViewVisibility),
		...written,
	},
	ConfirmedDelete: {},
	CompletedDeleteView: { viewId: Schema.String, result: Schema.Result(Schema.Void, LoadFailure) },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
	/** A view was picked: the page goes to its URL. */
	OpenedView: { url: Schema.String, search: Schema.Record(Schema.String, Schema.Json) },
	/** A write from the menu failed, with no dialog open to say so. */
	RequestedToast: { type: ToastType, title: Schema.String, description: Schema.String },
})
export type OutMessage = typeof OutMessage.Type

/** The page's view: the one its URL matches, else the one it was opened from, since edited. */
export type ActiveView = Readonly<{ view: SavedView; isModified: boolean }>

export const activeViewOf = (
	model: Pick<Model, "views" | "activeViewId">,
	explorer: Explorer,
): ActiveView | null => {
	const views = model.views ?? []
	const currentHref = explorer.hrefOf(explorer.current)
	const matches = (view: SavedView) => explorer.hrefOf(view.state) === currentHref
	const opened = Arr.findFirst(views, (view) => view.id === model.activeViewId)
	// The opened view wins a tie: two views can hold the same params.
	const exact = Option.orElse(Option.filter(opened, matches), () => Arr.findFirst(views, matches))
	return Option.getOrNull(
		Option.orElse(
			Option.map(exact, (view): ActiveView => ({ view, isModified: false })),
			() => Option.map(opened, (view): ActiveView => ({ view, isModified: true })),
		),
	)
}

/**
 * The view the URL is, remembered before the URL moves on. A page entered on a view's URL (a
 * reload, a link, another page's menu) then keeps it as its view once a param is edited.
 */
export const remembered = (model: Model, explorer: Explorer): Model => {
	const active = activeViewOf(model, explorer)
	return active === null || active.isModified || active.view.id === model.activeViewId
		? model
		: { ...model, activeViewId: active.view.id }
}
