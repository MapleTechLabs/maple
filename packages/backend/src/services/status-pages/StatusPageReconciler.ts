import { randomUUID } from "node:crypto"
import * as PG from "@maple-dev/effect-orm/postgres"
import type { MapleDb } from "@maple/db/client"
import {
	StatusPageComponents,
	StatusPageIncidentComponents,
	StatusPageIncidents,
	StatusPageIncidentUpdates,
	StatusPages,
} from "@maple/db/tables"
import {
	type OrgId,
	type StatusPageComponentId,
	type StatusPageId,
	StatusPageIncidentId,
	StatusPageIncidentUpdateId,
} from "@maple/domain/primitives"
import type { StatusPageOverlayEntry } from "@maple/domain/status-page"
import { Context, Effect, Layer, Option, Ref, Result, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { bumpPage } from "./outbox"
import { StatusPagePublishDbError } from "./publish-errors"
import { StatusPageStore, type StatusPageStoreError } from "./StatusPageStore"

// Imports break-glass overlay entries (posted to the status Worker while Maple was down) into
// Postgres. Each update keeps `overlay_entry_id`, unique, so importing an entry twice is a no-op.

const RECONCILE_BATCH = 100
const RECONCILE_CONCURRENCY = 4
const OVERLAY_INCIDENT_PREFIX = "bg-"

export interface StatusPageReconcileResult {
	/** Entries now in Postgres (including ones a previous run already imported). */
	readonly imported: number
}

export interface StatusPageReconcileAllResult {
	readonly pages: number
	readonly imported: number
	readonly failed: number
}

export type StatusPageReconcileError = StatusPagePublishDbError | StatusPageStoreError

export interface StatusPageReconcilerApi {
	readonly reconcile: (
		pageId: StatusPageId,
	) => Effect.Effect<StatusPageReconcileResult, StatusPageReconcileError>
	/** Reconciles every page with a break-glass token; a failing page is logged and skipped. */
	readonly reconcileAll: () => Effect.Effect<StatusPageReconcileAllResult, StatusPagePublishDbError>
}

const isResolved = (status: StatusPageOverlayEntry["status"]) =>
	status === "resolved" || status === "completed"
const decodeIncidentId = Schema.decodeUnknownOption(StatusPageIncidentId)

interface PageScope {
	readonly orgId: OrgId
	readonly pageId: StatusPageId
	readonly componentIds: ReadonlyArray<StatusPageComponentId>
}

/** The real incident an entry targets, if it still exists on this page. */
const findTarget = (db: MapleDb, scope: PageScope, entry: StatusPageOverlayEntry) =>
	Effect.gen(function* () {
		if (entry.incidentId === null) return Option.none<StatusPageIncidentId>()
		if (entry.incidentId.startsWith(OVERLAY_INCIDENT_PREFIX)) {
			// An incident the overlay opened: its first update carries the opening entry's id.
			const openingEntryId = entry.incidentId.slice(OVERLAY_INCIDENT_PREFIX.length)
			const rows = yield* db.run(
				PG.from(StatusPageIncidentUpdates)
					.select(($) => ({ incidentId: $.incidentId }))
					.where(($) => [$.orgId.eq(scope.orgId), $.overlayEntryId.eq(openingEntryId)])
					.limit(1),
			)
			return Option.fromNullishOr(rows[0]?.incidentId)
		}
		const id = decodeIncidentId(entry.incidentId)
		if (Option.isNone(id)) return Option.none<StatusPageIncidentId>()
		const rows = yield* db.run(
			PG.from(StatusPageIncidents)
				.select(($) => ({ id: $.id }))
				.where(($) => [$.orgId.eq(scope.orgId), $.pageId.eq(scope.pageId), $.id.eq(id.value)])
				.limit(1),
		)
		return Option.fromNullishOr(rows[0]?.id)
	})

const linkComponents = (
	db: MapleDb,
	scope: PageScope,
	incidentId: StatusPageIncidentId,
	requested: ReadonlyArray<string>,
) => {
	const componentIds = scope.componentIds.filter((id) => requested.includes(id))
	if (componentIds.length === 0) return Effect.void
	return db.run(
		PG.insertInto(StatusPageIncidentComponents)
			.values(componentIds.map((componentId) => ({ incidentId, componentId, orgId: scope.orgId })))
			.onConflictDoNothing(),
	)
}

/** Imports one entry in its own transaction. */
const importEntry = (db: MapleDb, scope: PageScope, entry: StatusPageOverlayEntry) =>
	db.transaction(
		Effect.gen(function* () {
			const already = yield* db.run(
				PG.from(StatusPageIncidentUpdates)
					.select(($) => ({ id: $.id }))
					.where(($) => [$.orgId.eq(scope.orgId), $.overlayEntryId.eq(entry.id)])
					.limit(1),
			)
			if (already.length > 0) return
			const resolvedAt = isResolved(entry.status) ? entry.at : null
			const target = yield* findTarget(db, scope, entry)
			// An entry whose target is gone opens its own incident rather than losing the customer's words.
			const incidentId = yield* Option.match(target, {
				onSome: (id) =>
					db
						.run(
							PG.update(StatusPageIncidents)
								.set({
									status: entry.status,
									impact: entry.impact,
									resolvedAt,
									updatedAt: entry.at,
									...(entry.title === null ? undefined : { title: entry.title }),
								})
								.where(($) => [$.orgId.eq(scope.orgId), $.id.eq(id)]),
						)
						.pipe(Effect.as(id)),
				onNone: () => {
					const id = StatusPageIncidentId.make(randomUUID())
					return db
						.run(
							PG.insertInto(StatusPageIncidents).values({
								id,
								orgId: scope.orgId,
								pageId: scope.pageId,
								kind: "incident",
								title: entry.title ?? "Service disruption",
								impact: entry.impact,
								status: entry.status,
								published: true,
								alertIncidentId: null,
								scheduledStart: null,
								scheduledEnd: null,
								startedAt: entry.at,
								resolvedAt,
								createdBy: null,
								createdAt: entry.at,
								updatedAt: entry.at,
							}),
						)
						.pipe(Effect.as(id))
				},
			})
			yield* linkComponents(db, scope, incidentId, entry.componentIds)
			yield* db.run(
				PG.insertInto(StatusPageIncidentUpdates)
					.values({
						id: StatusPageIncidentUpdateId.make(randomUUID()),
						orgId: scope.orgId,
						incidentId,
						status: entry.status,
						body: entry.body,
						source: "break_glass",
						createdBy: null,
						overlayEntryId: entry.id,
						createdAt: entry.at,
					})
					.onConflictDoNothing(),
			)
			yield* bumpPage(db, scope.orgId, scope.pageId)
		}),
	)

const toDbError = makePersistenceErrorMapper(StatusPagePublishDbError, "Status page overlay import failed")

export class StatusPageReconciler extends Context.Service<StatusPageReconciler, StatusPageReconcilerApi>()(
	"@maple/backend/services/status-pages/StatusPageReconciler",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const store = yield* StatusPageStore
			const dbExecute = makeDbExecute(database, "StatusPageReconciler", toDbError)

			const reconcile = Effect.fn("StatusPageReconciler.reconcile")(function* (pageId: StatusPageId) {
				yield* Effect.annotateCurrentSpan({ "maple.status_page.id": pageId })
				const overlay = yield* store.readOverlay(pageId)
				if (overlay.entries.length === 0) return { imported: 0 }
				const scope = yield* dbExecute((db) =>
					Effect.gen(function* () {
						const [page] = yield* db.run(
							PG.from(StatusPages)
								.select(($) => ({ orgId: $.orgId }))
								.where(($) => [$.id.eq(pageId)])
								.limit(1),
						)
						if (page === undefined) return null
						const components = yield* db.run(
							PG.from(StatusPageComponents)
								.select(($) => ({ id: $.id }))
								.where(($) => [$.orgId.eq(page.orgId), $.pageId.eq(pageId)]),
						)
						return { orgId: page.orgId, pageId, componentIds: components.map((c) => c.id) }
					}),
				)
				if (scope === null) return { imported: 0 }
				const entries = overlay.entries.toSorted((a, b) => a.at - b.at)
				const imported = yield* Ref.make<ReadonlyArray<string>>([])
				// In order: a later entry can target the incident an earlier one opened.
				const outcome = yield* Effect.result(
					Effect.forEach(
						entries,
						(entry) =>
							dbExecute((db) => importEntry(db, scope, entry)).pipe(
								Effect.andThen(Ref.update(imported, (ids) => [...ids, entry.id])),
							),
						{ discard: true },
					),
				)
				const importedIds = yield* Ref.get(imported)
				yield* store.removeOverlayEntries(pageId, importedIds)
				yield* Effect.annotateCurrentSpan({ "maple.status_page.imported_count": importedIds.length })
				if (Result.isFailure(outcome)) return yield* Effect.fail(outcome.failure)
				return { imported: importedIds.length }
			})

			const reconcileAll = Effect.fn("StatusPageReconciler.reconcileAll")(function* () {
				const pages = yield* dbExecute((db) =>
					db.run(
						PG.from(StatusPages)
							.select(($) => ({ id: $.id }))
							.where(($) => [$.breakGlassTokenSha256.isNotNull()])
							.orderBy(["id", "asc"])
							.limit(RECONCILE_BATCH),
					),
				)
				const outcomes = yield* Effect.forEach(
					pages,
					({ id }) =>
						reconcile(id).pipe(
							Effect.map((result) => result.imported),
							Effect.catch((error) =>
								Effect.logWarning("Status page overlay import failed").pipe(
									Effect.annotateLogs({
										"maple.status_page.id": id,
										"error.type": error._tag,
										"error.message": error.message,
									}),
									Effect.as(null),
								),
							),
						),
					{ concurrency: RECONCILE_CONCURRENCY },
				)
				const result: StatusPageReconcileAllResult = {
					pages: pages.length,
					imported: outcomes.reduce<number>((sum, n) => sum + (n ?? 0), 0),
					failed: outcomes.filter((n) => n === null).length,
				}
				yield* Effect.annotateCurrentSpan({
					"maple.status_page.page_count": result.pages,
					"maple.status_page.imported_count": result.imported,
					"maple.status_page.failed_count": result.failed,
				})
				return result
			})

			return { reconcile, reconcileAll }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
