import { SavedViewId, UserId } from "@maple/domain/http"
import type { SavedViewState, SavedViewSurface } from "@maple/domain/saved-views"
import * as Menu from "@maple/views/ui/menu"
import { Array as Arr, Result, Schema } from "effect"
import type { PageOutMessage } from "../../contract"
import { Message, type SavedView } from "./model"
import { ITEM, viewItem } from "./update"

// Saved views for the explorers' scene tests, and the steps a person takes with the Views control,
// sent through the page's own update.

const decodeViewId = Schema.decodeSync(SavedViewId)
const VIEWER = Schema.decodeSync(UserId)("user_ana")

/** One of the viewer's own private views, as the API lists it; `suffix` is two hex digits. */
export const savedView = (
	surface: SavedViewSurface,
	suffix: string,
	name: string,
	state: SavedViewState,
): SavedView => ({
	id: decodeViewId(`00000000-0000-4000-8000-0000000000${suffix}`),
	surface,
	name,
	state,
	visibility: "private",
	ownerUserId: VIEWER,
	ownerName: null,
	isOwner: true,
	canDelete: true,
	createdAt: 0,
	updatedAt: 0,
})

type Sent = ReadonlyArray<{ readonly name: string; readonly args?: unknown }> | undefined

/** The Commands of one name a step sent, as name and arguments. */
export const sentNamed = (commands: Sent, name: string) =>
	Arr.filter(
		Arr.map(commands ?? [], (command) => ({ name: command.name, args: command.args })),
		(command) => command.name === name,
	)

/** A requested navigation, its URL decoded for reading; `null` for anything else. */
export const navigationOf = (out: PageOutMessage | undefined) =>
	out !== undefined && out._tag === "RequestedNavigation"
		? { url: decodeURIComponent(out.url), isReplace: out.isReplace }
		: null

type Step<Model> = { readonly model: Model; readonly commands?: Sent; readonly outMessage?: PageOutMessage }

/** The control driven through a page: `send` is the page's update over the control's Message. */
export const viewsDriver = <Model>(send: (model: Model, message: Message) => Step<Model>) => {
	const pick = (model: Model, value: string): Step<Model> =>
		send(
			model,
			Message.GotMenuMessage({
				message: Menu.Message.ClickedItem({ index: 0, item: { kind: "Item", value } }),
			}),
		)
	return {
		/** The list answered with `views`. */
		listed: (model: Model, views: ReadonlyArray<SavedView>): Model =>
			send(model, Message.CompletedFetchViews({ revision: 0, result: Result.succeed(views) })).model,
		/** A view picked from the menu. */
		open: (model: Model, view: SavedView): Step<Model> => pick(model, viewItem(view.id)),
		/** "Save view…", the name typed, the dialog submitted. */
		saveAs: (model: Model, name: string): Step<Model> =>
			send(
				send(pick(model, ITEM.save).model, Message.ChangedName({ value: name })).model,
				Message.SubmittedForm(),
			),
		/** "Update view" on an edited view. */
		update: (model: Model): Step<Model> => pick(model, ITEM.update),
		/** "Rename…" through to the API's answer. */
		renamed: (model: Model, view: SavedView, name: string): Model => {
			const typed = send(pick(model, ITEM.rename).model, Message.ChangedName({ value: name })).model
			return send(
				send(typed, Message.SubmittedForm()).model,
				Message.CompletedRenameView({ result: Result.succeed({ ...view, name }) }),
			).model
		},
		/** "Delete…" confirmed: the request it sends. */
		confirmDelete: (model: Model): Step<Model> =>
			send(pick(model, ITEM.delete).model, Message.ConfirmedDelete()),
		/** The delete answered. */
		deleted: (model: Model, view: SavedView): Model =>
			send(model, Message.CompletedDeleteView({ viewId: view.id, result: Result.succeed(undefined) }))
				.model,
	}
}
