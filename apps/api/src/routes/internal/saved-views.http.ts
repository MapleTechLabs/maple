import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant, MapleInternalApi, SavedViewListResponse, SavedViewResponse } from "@maple/domain/http"
import { Array as Arr, Effect } from "effect"
import type { OrgMember } from "@maple/backend/services/org/OrgMembersService"
import { OrgMembersService } from "@maple/backend/services/org/OrgMembersService"
import { type SavedView, SavedViewsService } from "@maple/backend/services/saved-views/SavedViewsService"
import { orgMemberDirectory } from "../org-member-directory"

/** A member's name, else their email; `null` for someone the directory no longer lists. */
const ownerNameOf = (directory: ReadonlyMap<string, OrgMember>, view: SavedView): string | null => {
	const member = directory.get(view.ownerUserId)
	return member === undefined ? null : (member.name ?? member.email)
}

const toResponse = (view: SavedView, ownerName: string | null): SavedViewResponse =>
	new SavedViewResponse({
		id: view.id,
		surface: view.surface,
		name: view.name,
		state: view.state,
		visibility: view.visibility,
		ownerUserId: view.ownerUserId,
		ownerName,
		isOwner: view.isOwner,
		canDelete: view.canDelete,
		createdAt: view.createdAt,
		updatedAt: view.updatedAt,
	})

export const HttpSavedViewsLive = HttpApiBuilder.group(MapleInternalApi, "savedViews", (handlers) =>
	Effect.gen(function* () {
		const savedViews = yield* SavedViewsService
		const members = yield* OrgMembersService

		return handlers
			.handle("list", ({ query }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const views = yield* savedViews.list(query.surface)
					// Only someone else's view needs a name, so a list of the caller's own skips the directory.
					const directory = Arr.some(views, (view) => !view.isOwner)
						? yield* orgMemberDirectory(members, tenant.orgId)
						: new Map<string, OrgMember>()
					return new SavedViewListResponse({
						views: Arr.map(views, (view) =>
							toResponse(view, view.isOwner ? null : ownerNameOf(directory, view)),
						),
					})
				}),
			)
			.handle("create", ({ payload }) =>
				Effect.gen(function* () {
					const view = yield* savedViews.create(payload)
					return toResponse(view, null)
				}),
			)
			.handle("update", ({ params, payload }) =>
				Effect.gen(function* () {
					// Only the owner gets this far, and their own view carries no owner name.
					const view = yield* savedViews.update(params.viewId, payload)
					return toResponse(view, null)
				}),
			)
			.handle("delete", ({ params }) => savedViews.remove(params.viewId))
	}),
)
