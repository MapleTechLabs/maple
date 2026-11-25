import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Schema } from "effect"
import { SavedViewId, UserId } from "@maple/primitives"
import { SavedViewName, SavedViewState, SavedViewSurface, SavedViewVisibility } from "../saved-views"
import { EndpointAccess } from "./endpoint-access"
import { SessionAuthorization } from "./current-tenant"
import { HttpTaggedError } from "./error-policy"

// Saved views: a named snapshot of an explorer's URL search params (`/logs`, `/traces`, `/metrics`),
// private to its owner or shared with the organization.

export class SavedViewResponse extends Schema.Class<SavedViewResponse>("SavedViewResponse")({
	id: SavedViewId,
	surface: SavedViewSurface,
	name: Schema.String,
	state: SavedViewState,
	visibility: SavedViewVisibility,
	ownerUserId: UserId,
	/** The owner's name for a view someone else shared; `null` for the caller's own, or when unknown. */
	ownerName: Schema.NullOr(Schema.String),
	/** The caller owns it: only they rename it, update it or change who sees it. */
	isOwner: Schema.Boolean,
	/** The owner, or an org admin for a shared view. */
	canDelete: Schema.Boolean,
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
}) {}

export class SavedViewListResponse extends Schema.Class<SavedViewListResponse>("SavedViewListResponse")({
	/** The caller's own views first, then the ones shared with the organization, each by name. */
	views: Schema.Array(SavedViewResponse),
}) {}

export class CreateSavedViewRequest extends Schema.Class<CreateSavedViewRequest>("CreateSavedViewRequest")({
	surface: SavedViewSurface,
	name: SavedViewName,
	state: SavedViewState,
	/** Private unless said otherwise. */
	visibility: Schema.optionalKey(SavedViewVisibility),
}) {}

/** Every field is optional: a rename, new search params and a visibility change are the same call. */
export class UpdateSavedViewRequest extends Schema.Class<UpdateSavedViewRequest>("UpdateSavedViewRequest")({
	name: Schema.optionalKey(SavedViewName),
	state: Schema.optionalKey(SavedViewState),
	visibility: Schema.optionalKey(SavedViewVisibility),
}) {}

export class SavedViewPersistenceError extends HttpTaggedError<SavedViewPersistenceError>()(
	"@maple/http/saved-views/SavedViewPersistenceError",
	{ message: Schema.String, cause: Schema.optionalKey(Schema.String) },
	{
		status: 503,
		code: "saved_views_unavailable",
		title: "Saved views are temporarily unavailable",
		message: "Saved views could not be read or changed right now. Try again in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

/** No such view for the caller: it does not exist, is in another organization, or is someone's private view. */
export class SavedViewNotFoundError extends HttpTaggedError<SavedViewNotFoundError>()(
	"@maple/http/saved-views/SavedViewNotFoundError",
	{ message: Schema.String, viewId: SavedViewId },
	{
		status: 404,
		code: "saved_view_not_found",
		title: "View not found",
		retry: "never",
		recovery: "refresh",
		exposure: "public_message",
	},
) {}

/** The view is shared with the caller, but only its owner may change it. */
export class SavedViewForbiddenError extends HttpTaggedError<SavedViewForbiddenError>()(
	"@maple/http/saved-views/SavedViewForbiddenError",
	{ message: Schema.String, viewId: SavedViewId },
	{
		status: 403,
		code: "saved_view_forbidden",
		title: "Only the owner can change this view",
		retry: "never",
		recovery: "none",
		exposure: "public_message",
	},
) {}

/** The caller already has a view with this name in this explorer. */
export class SavedViewNameTakenError extends HttpTaggedError<SavedViewNameTakenError>()(
	"@maple/http/saved-views/SavedViewNameTakenError",
	{ message: Schema.String, name: Schema.String },
	{
		status: 409,
		code: "saved_view_name_taken",
		title: "Name already in use",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

/** The caller holds as many views in this explorer as one person may. */
export class SavedViewLimitError extends HttpTaggedError<SavedViewLimitError>()(
	"@maple/http/saved-views/SavedViewLimitError",
	{ message: Schema.String, limit: Schema.Number },
	{
		status: 422,
		code: "saved_view_limit",
		title: "Too many views",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

/** Session only: views belong to people, and an analyst keeps their own (`personal`). */
export class SavedViewsApiGroup extends HttpApiGroup.make("savedViews")
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: { surface: SavedViewSurface },
			success: SavedViewListResponse,
			error: SavedViewPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: CreateSavedViewRequest,
			success: SavedViewResponse,
			error: [SavedViewPersistenceError, SavedViewNameTakenError, SavedViewLimitError],
		}).annotate(EndpointAccess, "personal"),
	)
	.add(
		HttpApiEndpoint.patch("update", "/:viewId", {
			params: { viewId: SavedViewId },
			payload: UpdateSavedViewRequest,
			success: SavedViewResponse,
			error: [
				SavedViewPersistenceError,
				SavedViewNotFoundError,
				SavedViewForbiddenError,
				SavedViewNameTakenError,
			],
		}).annotate(EndpointAccess, "personal"),
	)
	.add(
		HttpApiEndpoint.delete("delete", "/:viewId", {
			params: { viewId: SavedViewId },
			success: Schema.Void,
			error: [SavedViewPersistenceError, SavedViewNotFoundError, SavedViewForbiddenError],
		}).annotate(EndpointAccess, "personal"),
	)
	.prefix("/internal/saved-views")
	.middleware(SessionAuthorization) {}
