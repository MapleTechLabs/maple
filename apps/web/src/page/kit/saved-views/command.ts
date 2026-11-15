import { CreateSavedViewRequest, SavedViewId, UpdateSavedViewRequest } from "@maple/domain/http"
import { SavedViewState, SavedViewSurface, SavedViewVisibility } from "@maple/domain/saved-views"
import { settleTo } from "@maple/views/data/load-failure"
import { Array as Arr, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { MapleInternalApiClient } from "../../../platform/api-clients"
import { Message, type SavedView } from "./model"

// The saved views reads and writes, over plain HTTP: the list is fetched when the explorer opens
// and again when its menu does, never synced.

const plain = (view: SavedView): SavedView => ({ ...view })

/** The caller's own views and the ones shared with the org, for one explorer. */
export const FetchViews = Command.define("FetchSavedViews", {
	args: { surface: SavedViewSurface, revision: Schema.Number },
	messages: [Message.CompletedFetchViews],
	execute: ({ surface, revision }) =>
		Effect.flatMap(MapleInternalApiClient, (client) =>
			client.savedViews.list({ query: { surface } }),
		).pipe(
			Effect.map((response) => Arr.map(response.views, plain)),
			settleTo((result) => Message.CompletedFetchViews({ revision, result })),
		),
})

export const CreateView = Command.define("CreateSavedView", {
	args: {
		surface: SavedViewSurface,
		name: Schema.String,
		state: SavedViewState,
		visibility: SavedViewVisibility,
	},
	messages: [Message.CompletedCreateView],
	execute: ({ surface, name, state, visibility }) =>
		Effect.flatMap(MapleInternalApiClient, (client) =>
			client.savedViews.create({
				payload: new CreateSavedViewRequest({ surface, name, state, visibility }),
			}),
		).pipe(
			Effect.map(plain),
			settleTo((result) => Message.CompletedCreateView({ result })),
		),
})

export const RenameView = Command.define("RenameSavedView", {
	args: { viewId: SavedViewId, name: Schema.String },
	messages: [Message.CompletedRenameView],
	execute: ({ viewId, name }) =>
		Effect.flatMap(MapleInternalApiClient, (client) =>
			client.savedViews.update({ params: { viewId }, payload: new UpdateSavedViewRequest({ name }) }),
		).pipe(
			Effect.map(plain),
			settleTo((result) => Message.CompletedRenameView({ result })),
		),
})

/** "Update view": the view's params become the page's current ones. */
export const UpdateViewState = Command.define("UpdateSavedViewState", {
	args: { viewId: SavedViewId, state: SavedViewState },
	messages: [Message.CompletedUpdateView],
	execute: ({ viewId, state }) =>
		Effect.flatMap(MapleInternalApiClient, (client) =>
			client.savedViews.update({ params: { viewId }, payload: new UpdateSavedViewRequest({ state }) }),
		).pipe(
			Effect.map(plain),
			settleTo((result) =>
				Message.CompletedUpdateView({ action: "update", viewId, sharedBefore: null, result }),
			),
		),
})

export const SetViewVisibility = Command.define("SetSavedViewVisibility", {
	args: { viewId: SavedViewId, visibility: SavedViewVisibility },
	messages: [Message.CompletedUpdateView],
	execute: ({ viewId, visibility }) =>
		Effect.flatMap(MapleInternalApiClient, (client) =>
			client.savedViews.update({
				params: { viewId },
				payload: new UpdateSavedViewRequest({ visibility }),
			}),
		).pipe(
			Effect.map(plain),
			settleTo((result) =>
				Message.CompletedUpdateView({
					action: "share",
					viewId,
					// The toggle only ever flips, so what was there before is the other value.
					sharedBefore: visibility === "org" ? "private" : "org",
					result,
				}),
			),
		),
})

export const DeleteView = Command.define("DeleteSavedView", {
	args: { viewId: SavedViewId },
	messages: [Message.CompletedDeleteView],
	execute: ({ viewId }) =>
		Effect.flatMap(MapleInternalApiClient, (client) =>
			client.savedViews.delete({ params: { viewId } }),
		).pipe(settleTo((result) => Message.CompletedDeleteView({ viewId, result }))),
})
