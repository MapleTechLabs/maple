import { randomUUID } from "node:crypto"
import * as PG from "@maple-dev/effect-orm/postgres"
import { SavedViews, type SavedViewRow } from "@maple/db/tables"
import {
	SavedViewForbiddenError,
	SavedViewLimitError,
	SavedViewNameTakenError,
	SavedViewNotFoundError,
	SavedViewPersistenceError,
} from "@maple/domain/http"
import { highestRole, isAtLeast } from "@maple/domain/policy"
import type { SavedViewState, SavedViewSurface, SavedViewVisibility } from "@maple/domain/saved-views"
import { SavedViewId, type OrgId, type UserId } from "@maple/primitives"
import { Array as Arr, Clock, Context, Effect, Layer, Order, Schema, String as Str } from "effect"
import { Database, type DatabaseError } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { postgresSqlState } from "@maple/backend/platform/postgres-errors"

/** Who is asking: views are scoped to the org, owned by the user, and a shared one is an admin's to delete. */
export interface SavedViewCaller {
	readonly orgId: OrgId
	readonly userId: UserId
	readonly roles: ReadonlyArray<string>
}

/** A view as its caller may use it. */
export interface SavedView {
	readonly id: SavedViewId
	readonly surface: SavedViewSurface
	readonly name: string
	readonly state: SavedViewState
	readonly visibility: SavedViewVisibility
	readonly ownerUserId: UserId
	readonly isOwner: boolean
	readonly canDelete: boolean
	readonly createdAt: number
	readonly updatedAt: number
}

export interface CreateSavedViewInput {
	readonly surface: SavedViewSurface
	readonly name: string
	readonly state: SavedViewState
	readonly visibility?: SavedViewVisibility | undefined
}

export interface UpdateSavedViewInput {
	readonly name?: string | undefined
	readonly state?: SavedViewState | undefined
	readonly visibility?: SavedViewVisibility | undefined
}

export interface SavedViewsServiceApi {
	/** The caller's own views, then the ones shared with the org, each by name. */
	readonly list: (
		caller: SavedViewCaller,
		surface: SavedViewSurface,
	) => Effect.Effect<ReadonlyArray<SavedView>, SavedViewPersistenceError>
	readonly create: (
		caller: SavedViewCaller,
		input: CreateSavedViewInput,
	) => Effect.Effect<SavedView, SavedViewPersistenceError | SavedViewNameTakenError | SavedViewLimitError>
	/** Owner only. A view the caller cannot see answers as missing, never as forbidden. */
	readonly update: (
		caller: SavedViewCaller,
		viewId: SavedViewId,
		input: UpdateSavedViewInput,
	) => Effect.Effect<
		SavedView,
		SavedViewPersistenceError | SavedViewNotFoundError | SavedViewForbiddenError | SavedViewNameTakenError
	>
	/** The owner, or an org admin for a shared view. */
	readonly remove: (
		caller: SavedViewCaller,
		viewId: SavedViewId,
	) => Effect.Effect<void, SavedViewPersistenceError | SavedViewNotFoundError | SavedViewForbiddenError>
}

/**
 * One person's views per explorer. The menu lists them all, so the list stays readable. A soft
 * cap, checked before the insert without a lock: two saves racing at the edge may land one over.
 */
export const SAVED_VIEWS_PER_OWNER_LIMIT = 100

/** The most shared views of other members a list read returns, in a large org. The caller's own are all read. */
const SHARED_LIST_LIMIT = 500

const UNIQUE_VIOLATION = "23505"

const toPersistenceError = makePersistenceErrorMapper(
	SavedViewPersistenceError,
	"Saved view persistence failed",
)

const decodeId = Schema.decodeUnknownSync(SavedViewId)

const isOrgAdmin = (caller: SavedViewCaller): boolean => isAtLeast(highestRole(caller.roles), "admin")

const toView = (caller: SavedViewCaller, row: SavedViewRow): SavedView => {
	const isOwner = row.ownerUserId === caller.userId
	return {
		id: row.id,
		surface: row.surface,
		name: row.name,
		state: row.state,
		visibility: row.visibility,
		ownerUserId: row.ownerUserId,
		isOwner,
		canDelete: isOwner || (row.visibility === "org" && isOrgAdmin(caller)),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	}
}

// Own views first, then shared ones; each group by name, ignoring case.
const listOrder: Order.Order<SavedView> = Order.combine(
	Order.mapInput(Order.Boolean, (view: SavedView) => !view.isOwner),
	Order.mapInput(Order.String, (view: SavedView) => Str.toLowerCase(view.name)),
)

export class SavedViewsService extends Context.Service<SavedViewsService, SavedViewsServiceApi>()(
	"@maple/backend/services/saved-views/SavedViewsService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const dbExecute = makeDbExecute(database, "SavedViewsService", toPersistenceError)
			// The owner's names are unique per explorer: a taken one lands on the index.
			const dbExecuteNamed = (name: string) =>
				makeDbExecute(database, "SavedViewsService", (error: DatabaseError) =>
					postgresSqlState(error) === UNIQUE_VIOLATION
						? new SavedViewNameTakenError({
								message: `You already have a view named "${name}"`,
								name,
							})
						: toPersistenceError(error),
				)

			/** The view as the caller may see it: missing when it is another org's or someone's private view. */
			const visibleRow = Effect.fn("SavedViewsService.visibleRow")(function* (
				caller: SavedViewCaller,
				viewId: SavedViewId,
			) {
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.from(SavedViews)
							.select()
							.where(($) => [$.orgId.eq(caller.orgId), $.id.eq(viewId)])
							.limit(1),
					),
				)
				const row = rows[0]
				if (row === undefined || (row.ownerUserId !== caller.userId && row.visibility !== "org")) {
					return yield* new SavedViewNotFoundError({ message: "View not found", viewId })
				}
				return row
			})

			const list = Effect.fn("SavedViewsService.list")(function* (
				caller: SavedViewCaller,
				surface: SavedViewSurface,
			) {
				yield* Effect.annotateCurrentSpan({
					orgId: caller.orgId,
					"tenant.userId": caller.userId,
					"maple.saved_view.surface": surface,
				})
				// Two reads, so other members' shared views can never crowd out the caller's own.
				const own = yield* dbExecute((db) =>
					db.run(
						PG.from(SavedViews)
							.select()
							.where(($) => [
								$.orgId.eq(caller.orgId),
								$.surface.eq(surface),
								$.ownerUserId.eq(caller.userId),
							])
							.orderBy(["updatedAt", "desc"], ["id", "asc"]),
					),
				)
				const shared = yield* dbExecute((db) =>
					db.run(
						PG.from(SavedViews)
							.select()
							.where(($) => [
								$.orgId.eq(caller.orgId),
								$.surface.eq(surface),
								$.ownerUserId.neq(caller.userId),
								$.visibility.eq("org"),
							])
							.orderBy(["updatedAt", "desc"], ["id", "asc"])
							.limit(SHARED_LIST_LIMIT),
					),
				)
				const rows = [...own, ...shared]
				yield* Effect.annotateCurrentSpan("result.rowCount", rows.length)
				return Arr.sort(
					Arr.map(rows, (row) => toView(caller, row)),
					listOrder,
				)
			})

			const create = Effect.fn("SavedViewsService.create")(function* (
				caller: SavedViewCaller,
				input: CreateSavedViewInput,
			) {
				yield* Effect.annotateCurrentSpan({
					orgId: caller.orgId,
					"tenant.userId": caller.userId,
					"maple.saved_view.surface": input.surface,
				})
				const owned = yield* dbExecute((db) =>
					db.run(
						PG.from(SavedViews)
							.select(($) => ({ id: $.id }))
							.where(($) => [
								$.orgId.eq(caller.orgId),
								$.ownerUserId.eq(caller.userId),
								$.surface.eq(input.surface),
							])
							.limit(SAVED_VIEWS_PER_OWNER_LIMIT),
					),
				)
				if (owned.length >= SAVED_VIEWS_PER_OWNER_LIMIT) {
					return yield* new SavedViewLimitError({
						message: `You can keep up to ${SAVED_VIEWS_PER_OWNER_LIMIT} views here. Delete one to save another.`,
						limit: SAVED_VIEWS_PER_OWNER_LIMIT,
					})
				}
				const now = yield* Clock.currentTimeMillis
				const rows = yield* dbExecuteNamed(input.name)((db) =>
					db.run(
						PG.insertInto(SavedViews)
							.values({
								id: decodeId(randomUUID()),
								orgId: caller.orgId,
								ownerUserId: caller.userId,
								surface: input.surface,
								name: input.name,
								state: input.state,
								visibility: input.visibility ?? "private",
								createdAt: now,
								updatedAt: now,
							})
							.returning(),
					),
				)
				const row = rows[0]
				if (row === undefined) {
					return yield* new SavedViewPersistenceError({ message: "Insert returned no row" })
				}
				return toView(caller, row)
			})

			const update = Effect.fn("SavedViewsService.update")(function* (
				caller: SavedViewCaller,
				viewId: SavedViewId,
				input: UpdateSavedViewInput,
			) {
				yield* Effect.annotateCurrentSpan({ orgId: caller.orgId, "tenant.userId": caller.userId })
				const existing = yield* visibleRow(caller, viewId)
				if (existing.ownerUserId !== caller.userId) {
					return yield* new SavedViewForbiddenError({
						message: "Only the owner can change this view",
						viewId,
					})
				}
				const now = yield* Clock.currentTimeMillis
				const rows = yield* dbExecuteNamed(input.name ?? existing.name)((db) =>
					db.run(
						PG.update(SavedViews)
							.set({
								...(input.name === undefined ? undefined : { name: input.name }),
								...(input.state === undefined ? undefined : { state: input.state }),
								...(input.visibility === undefined
									? undefined
									: { visibility: input.visibility }),
								updatedAt: now,
							})
							// The owner is part of the match, so a row that changed hands is never written.
							.where(($) => [
								$.orgId.eq(caller.orgId),
								$.id.eq(viewId),
								$.ownerUserId.eq(caller.userId),
							])
							.returning(),
					),
				)
				const row = rows[0]
				// Deleted between the read and the write.
				if (row === undefined) {
					return yield* new SavedViewNotFoundError({ message: "View not found", viewId })
				}
				return toView(caller, row)
			})

			const remove = Effect.fn("SavedViewsService.remove")(function* (
				caller: SavedViewCaller,
				viewId: SavedViewId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId: caller.orgId, "tenant.userId": caller.userId })
				const existing = yield* visibleRow(caller, viewId)
				if (!toView(caller, existing).canDelete) {
					return yield* new SavedViewForbiddenError({
						message: "Only the owner or an org admin can delete this view",
						viewId,
					})
				}
				const isOwner = existing.ownerUserId === caller.userId
				// An admin's delete holds only while the view is still shared: an owner who made it
				// private in the meantime keeps it.
				const deleted = yield* dbExecute((db) =>
					db.run(
						PG.deleteFrom(SavedViews)
							.where(($) => [
								$.orgId.eq(caller.orgId),
								$.id.eq(viewId),
								isOwner ? $.ownerUserId.eq(caller.userId) : $.visibility.eq("org"),
							])
							.returning(($) => ({ id: $.id })),
					),
				)
				if (deleted.length === 0) {
					return yield* new SavedViewNotFoundError({ message: "View not found", viewId })
				}
			})

			return { list, create, update, remove } satisfies SavedViewsServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
