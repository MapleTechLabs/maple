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
	type StatusPageIncidentImpact,
	type StatusPageIncidentKind,
	type StatusPageIncidentStatus,
	StatusPageIncidentUpdateId,
} from "@maple/domain/primitives"
import { StatusPageKeys, statusFitsKind, type StatusPageOverlayEntry } from "@maple/domain/status-page"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { repairMissingAutoIncidents, repairOrphanedAutoIncidents } from "./auto-incidents"
import { bumpPage } from "./outbox"
import { StatusPagePublishDbError } from "./publish-errors"
import { parseOverlayKey, StatusPageStore, type StatusPageStoreError } from "./StatusPageStore"

// Imports break-glass entries (one KV key each, posted to the status Worker while Maple was
// down) into Postgres. Each update keeps `overlay_entry_id`, unique, so an import is idempotent;
// a key is deleted only once a published snapshot carries its update.

/** KV list calls one run makes at most (1000 keys each). */
const RECONCILE_LIST_PAGES = 10
const RECONCILE_CONCURRENCY = 4
const ENTRY_READ_CONCURRENCY = 8
const OVERLAY_INCIDENT_PREFIX = "bg-"

export interface StatusPageReconcileResult {
	/** Entries imported by this run. */
	readonly imported: number
	/** Entry keys deleted because a published snapshot carries them. */
	readonly cleared: number
}

export interface StatusPageReconcileAllResult {
	readonly pages: number
	readonly imported: number
	readonly cleared: number
	readonly failed: number
}

export type StatusPageReconcileError = StatusPagePublishDbError | StatusPageStoreError

export interface StatusPageReconcilerApi {
	readonly reconcile: (
		pageId: StatusPageId,
	) => Effect.Effect<StatusPageReconcileResult, StatusPageReconcileError>
	/** Reconciles every page with break-glass entries in KV; a failing page is logged and skipped. */
	readonly reconcileAll: () => Effect.Effect<StatusPageReconcileAllResult, StatusPageReconcileError>
	/** Resolves auto incidents whose alert incident is resolved or gone; returns how many. */
	readonly repairAutoIncidents: () => Effect.Effect<number, StatusPagePublishDbError>
}

/** A concurrent import inserted the entry's update first; rolls this attempt back. */
class StatusPageOverlayImportRaced extends Schema.TaggedError<StatusPageOverlayImportRaced>()(
	"@maple/backend/status-pages/StatusPageOverlayImportRaced",
	{ message: Schema.String, entryId: Schema.String },
) {}

const isResolved = (status: StatusPageIncidentStatus) => status === "resolved" || status === "completed"
const decodeIncidentId = Schema.decodeUnknownOption(StatusPageIncidentId)

export interface PageScope {
	readonly orgId: OrgId
	readonly pageId: StatusPageId
	readonly componentIds: ReadonlyArray<StatusPageComponentId>
}

interface TargetIncident {
	readonly id: StatusPageIncidentId
	readonly kind: StatusPageIncidentKind
	readonly status: StatusPageIncidentStatus
	readonly impact: StatusPageIncidentImpact
	readonly resolvedAt: number | null
}

const targetColumns = PG.from(StatusPageIncidents).select(($) => ({
	id: $.id,
	kind: $.kind,
	status: $.status,
	impact: $.impact,
	resolvedAt: $.resolvedAt,
}))

/** The real incident an entry targets, if it still exists on this page. */
const findTarget = (db: MapleDb, scope: PageScope, entry: StatusPageOverlayEntry) =>
	Effect.gen(function* () {
		if (entry.incidentId === null) return Option.none<TargetIncident>()
		const byId = (id: StatusPageIncidentId) =>
			db
				.run(
					targetColumns
						.where(($) => [$.orgId.eq(scope.orgId), $.pageId.eq(scope.pageId), $.id.eq(id)])
						.limit(1),
				)
				.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])))
		if (entry.incidentId.startsWith(OVERLAY_INCIDENT_PREFIX)) {
			// `bg-<entry>`: the incident that entry opened (or updated) holds its update.
			const openingEntryId = entry.incidentId.slice(OVERLAY_INCIDENT_PREFIX.length)
			const [opening] = yield* db.run(
				PG.from(StatusPageIncidentUpdates)
					.select(($) => ({ incidentId: $.incidentId }))
					.where(($) => [$.orgId.eq(scope.orgId), $.overlayEntryId.eq(openingEntryId)])
					.limit(1),
			)
			return opening === undefined ? Option.none<TargetIncident>() : yield* byId(opening.incidentId)
		}
		const id = decodeIncidentId(entry.incidentId)
		return Option.isNone(id) ? Option.none<TargetIncident>() : yield* byId(id.value)
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

/** Writes the incident change for an entry; returns the incident and the status its update records. */
const applyToIncident = (db: MapleDb, scope: PageScope, entry: StatusPageOverlayEntry) =>
	Effect.gen(function* () {
		const target = yield* findTarget(db, scope, entry)
		if (Option.isSome(target)) {
			const existing = target.value
			// Null keeps the current value; a status from the other lifecycle is ignored.
			const status =
				entry.status !== null && statusFitsKind(existing.kind, entry.status)
					? entry.status
					: existing.status
			yield* db.run(
				PG.update(StatusPageIncidents)
					.set({
						status,
						impact: entry.impact ?? existing.impact,
						resolvedAt: isResolved(status) ? (existing.resolvedAt ?? entry.at) : null,
						updatedAt: entry.at,
						...(entry.title === null ? undefined : { title: entry.title }),
					})
					.where(($) => [$.orgId.eq(scope.orgId), $.id.eq(existing.id)]),
			)
			return { incidentId: existing.id, status }
		}
		// No target (or it is gone): open an incident rather than lose the customer's words.
		const id = StatusPageIncidentId.make(randomUUID())
		const status =
			entry.status !== null && statusFitsKind("incident", entry.status) ? entry.status : "investigating"
		yield* db.run(
			PG.insertInto(StatusPageIncidents).values({
				id,
				orgId: scope.orgId,
				pageId: scope.pageId,
				kind: "incident",
				title: entry.title ?? "Service disruption",
				impact: entry.impact ?? "major",
				status,
				published: true,
				alertIncidentId: null,
				scheduledStart: null,
				scheduledEnd: null,
				startedAt: entry.at,
				resolvedAt: isResolved(status) ? entry.at : null,
				createdBy: null,
				createdAt: entry.at,
				updatedAt: entry.at,
			}),
		)
		return { incidentId: id, status }
	})

/**
 * Imports one entry in one transaction. The update insert is the claim: when a concurrent
 * import already holds `overlay_entry_id`, the transaction rolls back, incident writes included.
 */
export const importEntry = (db: MapleDb, scope: PageScope, entry: StatusPageOverlayEntry) =>
	db
		.transaction(
			Effect.gen(function* () {
				const { incidentId, status } = yield* applyToIncident(db, scope, entry)
				yield* linkComponents(db, scope, incidentId, entry.componentIds)
				const claimed = yield* db.run(
					PG.insertInto(StatusPageIncidentUpdates)
						.values({
							id: StatusPageIncidentUpdateId.make(randomUUID()),
							orgId: scope.orgId,
							incidentId,
							status,
							body: entry.body,
							source: "break_glass",
							createdBy: null,
							overlayEntryId: entry.id,
							createdAt: entry.at,
						})
						.onConflictDoNothing()
						.returning("id"),
				)
				if (claimed.length === 0) {
					return yield* new StatusPageOverlayImportRaced({
						message: `Break-glass entry ${entry.id} was imported concurrently`,
						entryId: entry.id,
					})
				}
				yield* bumpPage(db, scope.orgId, scope.pageId)
			}),
		)
		.pipe(
			Effect.as(true),
			Effect.catchTag("@maple/backend/status-pages/StatusPageOverlayImportRaced", () =>
				Effect.succeed(false),
			),
		)

const toDbError = makePersistenceErrorMapper(StatusPagePublishDbError, "Status page overlay import failed")

export class StatusPageReconciler extends Context.Service<StatusPageReconciler, StatusPageReconcilerApi>()(
	"@maple/backend/services/status-pages/StatusPageReconciler",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const store = yield* StatusPageStore
			const dbExecute = makeDbExecute(database, "StatusPageReconciler", toDbError)

			/** Imports the page's entries and clears the keys a published snapshot already carries. */
			const reconcileEntries = Effect.fn("StatusPageReconciler.reconcilePage")(function* (
				pageId: StatusPageId,
				entryIds: ReadonlyArray<string>,
			) {
				yield* Effect.annotateCurrentSpan({
					"maple.status_page.id": pageId,
					"maple.status_page.entry_count": entryIds.length,
				})
				const read = yield* Effect.forEach(
					entryIds,
					(entryId) => store.readOverlayEntry(StatusPageKeys.overlayEntry(pageId, entryId)),
					{ concurrency: ENTRY_READ_CONCURRENCY },
				)
				// A key names its entry; one that disagrees is not trusted.
				const entries = read
					.flatMap((entry) =>
						Option.isSome(entry) && entryIds.includes(entry.value.id) ? [entry.value] : [],
					)
					.toSorted((a, b) => a.at - b.at)
				if (entries.length === 0) return { imported: 0, cleared: 0 }
				const page = yield* dbExecute((db) =>
					Effect.gen(function* () {
						const [row] = yield* db.run(
							PG.from(StatusPages)
								.select(($) => ({
									orgId: $.orgId,
									revision: $.revision,
									publishedRevision: $.publishedRevision,
									publishedAt: $.publishedAt,
								}))
								.where(($) => [$.id.eq(pageId)])
								.limit(1),
						)
						if (row === undefined) return null
						const components = yield* db.run(
							PG.from(StatusPageComponents)
								.select(($) => ({ id: $.id }))
								.where(($) => [$.orgId.eq(row.orgId), $.pageId.eq(pageId)]),
						)
						const existing = yield* db.run(
							PG.from(StatusPageIncidentUpdates)
								.select(($) => ({ overlayEntryId: $.overlayEntryId, createdAt: $.createdAt }))
								.where(($) => [
									$.orgId.eq(row.orgId),
									// OR of equalities: the unique index serves it on a nullable column.
									PG.or(...entries.map((entry) => $.overlayEntryId.eq(entry.id))),
								]),
						)
						return { ...row, componentIds: components.map((c) => c.id), existing }
					}),
				)
				// A deleted page's keys go with its edge cleanup.
				if (page === null) return { imported: 0, cleared: 0 }
				const scope: PageScope = { orgId: page.orgId, pageId, componentIds: page.componentIds }
				const imported = new Set(
					page.existing.flatMap((row) => (row.overlayEntryId === null ? [] : [row.overlayEntryId])),
				)
				// In order: a later entry can target the incident an earlier one opened.
				const outcomes = yield* Effect.forEach(
					entries.filter((entry) => !imported.has(entry.id)),
					(entry) => dbExecute((db) => importEntry(db, scope, entry)),
				)
				// Published at or past the revision read before this run's imports, and after the update.
				const { publishedAt } = page
				const carried =
					page.publishedRevision >= page.revision && publishedAt !== null
						? page.existing.flatMap((row) =>
								row.overlayEntryId !== null && publishedAt > row.createdAt
									? [row.overlayEntryId]
									: [],
							)
						: []
				yield* Effect.forEach(carried, (entryId) => store.deleteOverlayEntry(pageId, entryId), {
					concurrency: ENTRY_READ_CONCURRENCY,
					discard: true,
				})
				const result = { imported: outcomes.filter((ok) => ok).length, cleared: carried.length }
				yield* Effect.annotateCurrentSpan({
					"maple.status_page.imported_count": result.imported,
					"maple.status_page.cleared_count": result.cleared,
				})
				return result
			})

			/** Entry ids per page among the listed keys. */
			const groupByPage = (keys: ReadonlyArray<string>) =>
				keys.reduce<ReadonlyMap<StatusPageId, ReadonlyArray<string>>>((groups, key) => {
					const parsed = parseOverlayKey(key)
					if (Option.isNone(parsed)) return groups
					const { pageId, entryId } = parsed.value
					return new Map([...groups, [pageId, [...(groups.get(pageId) ?? []), entryId]]])
				}, new Map())

			const reconcile = Effect.fn("StatusPageReconciler.reconcile")(function* (pageId: StatusPageId) {
				const listing = yield* store.listKeys(
					StatusPageKeys.overlayPage(pageId),
					RECONCILE_LIST_PAGES,
				)
				const entryIds = groupByPage(listing.keys).get(pageId) ?? []
				if (entryIds.length === 0) return { imported: 0, cleared: 0 }
				return yield* reconcileEntries(pageId, entryIds)
			})

			const reconcileAll = Effect.fn("StatusPageReconciler.reconcileAll")(function* () {
				// Whether or not the page still has a token: entries posted before a revoke still count.
				const listing = yield* store.listKeys(StatusPageKeys.overlayAll, RECONCILE_LIST_PAGES)
				const pages = [...groupByPage(listing.keys)]
				const outcomes = yield* Effect.forEach(
					pages,
					([pageId, entryIds]) =>
						reconcileEntries(pageId, entryIds).pipe(
							Effect.map(Option.some),
							Effect.catch((error) =>
								Effect.logWarning("Status page overlay import failed").pipe(
									Effect.annotateLogs({
										"maple.status_page.id": pageId,
										"error.type": error._tag,
										"error.message": error.message,
									}),
									Effect.as(Option.none<StatusPageReconcileResult>()),
								),
							),
						),
					{ concurrency: RECONCILE_CONCURRENCY },
				)
				const done = outcomes.flatMap((outcome) => (Option.isSome(outcome) ? [outcome.value] : []))
				const result: StatusPageReconcileAllResult = {
					pages: pages.length,
					imported: done.reduce((sum, r) => sum + r.imported, 0),
					cleared: done.reduce((sum, r) => sum + r.cleared, 0),
					failed: outcomes.length - done.length,
				}
				yield* Effect.annotateCurrentSpan({
					"maple.status_page.page_count": result.pages,
					"maple.status_page.imported_count": result.imported,
					"maple.status_page.cleared_count": result.cleared,
					"maple.status_page.failed_count": result.failed,
					"maple.status_page.listing_complete": listing.complete,
				})
				return result
			})

			const repairAutoIncidents = Effect.fn("StatusPageReconciler.repairAutoIncidents")(function* () {
				const nowMs = yield* Clock.currentTimeMillis
				// Opens what the open hook missed, then resolves what the resolve hook missed.
				const opened = yield* dbExecute((db) => repairMissingAutoIncidents(db, nowMs))
				const resolved = yield* dbExecute((db) => repairOrphanedAutoIncidents(db, nowMs))
				const repaired = opened + resolved
				yield* Effect.annotateCurrentSpan({ "maple.status_page.repaired_count": repaired })
				return repaired
			})

			return { reconcile, reconcileAll, repairAutoIncidents }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
