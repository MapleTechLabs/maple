import * as PG from "@maple-dev/effect-orm/postgres"
import { StatusPageCleanups, StatusPages, UptimeMonitorDaily, UptimeMonitors } from "@maple/db/tables"
import type { StatusPageCleanupRow } from "@maple/db/tables"
import type { StatusPageId } from "@maple/domain/primitives"
import { utcDay } from "@maple/domain/status-page"
import { Clock, Context, Effect, Layer } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { bumpPage } from "./outbox"
import { StatusPageGoneError, StatusPagePublishDbError } from "./publish-errors"
import { StatusPageSnapshotBuilder } from "./StatusPageSnapshotBuilder"
import { StatusPageStore, type StatusPageStoreError } from "./StatusPageStore"

/** Pages published longer ago than this are republished so bars and freshness roll. */
export const STATUS_PAGE_REPUBLISH_AFTER_MS = 15 * 60_000
/** Pages one sweep publishes at most; the rest wait for the next minute. */
export const STATUS_PAGE_SWEEP_BATCH = 100
/** Edge cleanups one sweep drains at most, oldest first. */
export const STATUS_PAGE_CLEANUP_BATCH = 50
const SWEEP_CONCURRENCY = 4
const DAY_MS = 86_400_000

export interface StatusPagePublishResult {
	readonly pageId: StatusPageId
	readonly revision: number
	/** False when the content matched the last publish and the edge write was skipped. */
	readonly written: boolean
}

export interface StatusPageSweepResult {
	readonly due: number
	readonly written: number
	readonly unchanged: number
	readonly failed: number
	/** Edge cleanups done (their rows deleted) and ones left for the next sweep. */
	readonly cleaned: number
	readonly cleanupsFailed: number
}

export type StatusPagePublishError = StatusPageGoneError | StatusPagePublishDbError | StatusPageStoreError

export interface StatusPagePublisherApi {
	readonly publish: (pageId: StatusPageId) => Effect.Effect<StatusPagePublishResult, StatusPagePublishError>
	/**
	 * Drains edge cleanups, publishes pages whose revision lags or whose last publish is stale
	 * (a failing page is logged and skipped), then writes the heartbeat. A database failure
	 * fails the whole sweep, so no heartbeat claims a live publisher.
	 */
	readonly sweep: (nowMs: number) => Effect.Effect<StatusPageSweepResult, StatusPagePublishDbError>
	/** Writes the heartbeat with the newest scheduled check across all monitors. */
	readonly heartbeat: (
		nowMs: number,
	) => Effect.Effect<void, StatusPagePublishDbError | StatusPageStoreError>
}

const toHex = (buffer: ArrayBuffer) =>
	Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("")

/** SHA-256 hex of the text. */
export const sha256Hex = (text: string) =>
	Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).pipe(
		Effect.map(toHex),
	)

const toDbError = makePersistenceErrorMapper(StatusPagePublishDbError, "Status page publish write failed")

export class StatusPagePublisher extends Context.Service<StatusPagePublisher, StatusPagePublisherApi>()(
	"@maple/backend/services/status-pages/StatusPagePublisher",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const store = yield* StatusPageStore
			const builder = yield* StatusPageSnapshotBuilder
			const dbExecute = makeDbExecute(database, "StatusPagePublisher", toDbError)

			const recordFailure = (pageId: StatusPageId, nowMs: number, error: StatusPageStoreError) =>
				dbExecute((db) =>
					db.run(
						PG.update(StatusPages)
							.set({ lastPublishError: error.message, publishAttemptedAt: nowMs })
							.where(($) => [$.id.eq(pageId)]),
					),
				).pipe(Effect.ignore, Effect.andThen(Effect.fail(error)))

			const publish = Effect.fn("StatusPagePublisher.publish")(function* (pageId: StatusPageId) {
				yield* Effect.annotateCurrentSpan({ "maple.status_page.id": pageId })
				const [current] = yield* dbExecute((db) =>
					db.run(
						PG.from(StatusPages)
							.select(($) => ({
								orgId: $.orgId,
								revision: $.revision,
								publishedRevision: $.publishedRevision,
								publishedHash: $.publishedHash,
							}))
							.where(($) => [$.id.eq(pageId)])
							.limit(1),
					),
				)
				if (current === undefined) {
					return yield* new StatusPageGoneError({
						message: `Status page ${pageId} not found`,
						pageId,
					})
				}
				const nowMs = yield* Clock.currentTimeMillis
				const snapshot = yield* builder.build(pageId, nowMs)
				// The read revision, not the build's: a bump during the build republishes next sweep.
				const revision = current.revision
				// What a visitor sees: a bump or a stale republish with no visible change writes nothing.
				const hash = yield* sha256Hex(JSON.stringify({ ...snapshot, generatedAt: 0, revision: 0 }))
				const written = hash !== current.publishedHash
				if (written) {
					yield* store.putSnapshot(pageId, JSON.stringify(snapshot)).pipe(
						Effect.andThen(store.putRoutes(pageId, { slug: snapshot.page.slug, hostnames: [] })),
						Effect.catch((error) => recordFailure(pageId, nowMs, error)),
					)
				}
				// Advances only while no other publish moved it since our read, stale republishes included.
				const advanced = yield* dbExecute((db) =>
					db.run(
						PG.update(StatusPages)
							.set({
								publishedRevision: revision,
								publishedAt: nowMs,
								publishedHash: hash,
								publishAttemptedAt: nowMs,
								lastPublishError: null,
							})
							.where(($) => [
								$.id.eq(pageId),
								$.publishedRevision.eq(current.publishedRevision),
							])
							.returning("id"),
					),
				)
				if (advanced.length === 0) {
					// A concurrent publish got further; ours may have overwritten its snapshot, so go again.
					yield* dbExecute((db) =>
						db.run(
							PG.update(StatusPages)
								.set({
									publishedAt: nowMs,
									publishAttemptedAt: nowMs,
									lastPublishError: null,
								})
								.where(($) => [$.id.eq(pageId)]),
						),
					)
					if (written) yield* dbExecute((db) => bumpPage(db, current.orgId, pageId))
				}
				yield* Effect.annotateCurrentSpan({
					"maple.status_page.revision": revision,
					"maple.status_page.written": written,
				})
				return { pageId, revision, written }
			})

			/**
			 * Removes one cleanup's edge data; a slug another live page now uses is left alone. A page that
			 * still exists keeps its snapshot: its delete never committed (an org purge that failed later on).
			 */
			const cleanEdge = (row: StatusPageCleanupRow) =>
				Effect.gen(function* () {
					const alive = yield* dbExecute((db) =>
						db.run(
							PG.from(StatusPages)
								.select(($) => ({ id: $.id }))
								.where(($) => [$.id.eq(row.pageId)])
								.limit(1),
						),
					)
					const owners = yield* dbExecute((db) =>
						db.run(
							PG.from(StatusPages)
								.select(($) => ({ id: $.id }))
								.where(($) => [$.slug.eq(row.slug)])
								.limit(1),
						),
					)
					const routedTo = yield* store.readSlugRoute(row.slug)
					const slugIsOurs = owners.length === 0 && (routedTo === null || routedTo === row.pageId)
					if (slugIsOurs) yield* store.deleteRoutes({ slug: row.slug, hostnames: [] })
					if (row.deleteSnapshot && alive.length === 0) yield* store.deletePage(row.pageId)
				})

			/** Oldest first; a row goes only once its edge deletes succeeded. */
			const drainCleanups = Effect.gen(function* () {
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.from(StatusPageCleanups)
							.select()
							.orderBy(["createdAt", "asc"], ["id", "asc"])
							.limit(STATUS_PAGE_CLEANUP_BATCH),
					),
				)
				// In order: a rename's slug cleanup lands before a later delete of the same page.
				const outcomes = yield* Effect.forEach(rows, (row) =>
					cleanEdge(row).pipe(
						Effect.andThen(
							dbExecute((db) =>
								db.run(PG.deleteFrom(StatusPageCleanups).where(($) => [$.id.eq(row.id)])),
							),
						),
						Effect.as(true),
						Effect.catchTag("@maple/backend/status-pages/StatusPageStoreError", (error) =>
							Effect.logWarning("Status page edge cleanup failed").pipe(
								Effect.annotateLogs({
									"maple.status_page.id": row.pageId,
									"error.message": error.message,
								}),
								Effect.as(false),
							),
						),
					),
				)
				return {
					cleaned: outcomes.filter((ok) => ok).length,
					cleanupsFailed: outcomes.filter((ok) => !ok).length,
				}
			})

			const heartbeat = Effect.fn("StatusPagePublisher.heartbeat")(function* (nowMs: number) {
				// The daily counters fold in every scheduled check; their PK (monitor, day) serves this
				// per enabled monitor. Heartbeat monitors are excluded: their misses are not probes.
				const [seen] = yield* dbExecute((db) =>
					db.run(
						PG.from(UptimeMonitorDaily, "d")
							.innerJoin(UptimeMonitors, "m", (d, m) =>
								d.monitorId.eq(m.id).and(d.orgId.eq(m.orgId)),
							)
							.select(($) => ({ at: PG.max($.lastCheckAt) }))
							.where(($) => [
								$.m.enabled.eq(true),
								$.m.kind.neq("heartbeat"),
								PG.inList($.day, [utcDay(nowMs), utcDay(nowMs - DAY_MS)]),
							]),
					),
				)
				yield* store.putHeartbeat({ at: nowMs, probesSeenAt: seen?.at ?? null })
			})

			const sweep = Effect.fn("StatusPagePublisher.sweep")(function* (nowMs: number) {
				const cleanups = yield* drainCleanups
				const staleBefore = nowMs - STATUS_PAGE_REPUBLISH_AFTER_MS
				// Longest-waiting attempt first (never-attempted before all), so failing pages can't starve the rest.
				const due = yield* dbExecute((db) =>
					db.run(
						PG.from(StatusPages)
							.select(($) => ({ id: $.id }))
							.where(($) => [
								PG.or(
									$.revision.gt($.publishedRevision),
									$.publishedAt.isNull(),
									$.publishedAt.lt(staleBefore),
								),
							])
							.orderBy(($) => [
								[PG.asBoolean($.publishAttemptedAt.isNotNull()), "asc"],
								[$.publishAttemptedAt, "asc"],
								[$.id, "asc"],
							])
							.limit(STATUS_PAGE_SWEEP_BATCH),
					),
				)
				// Marked up front, so a page whose build fails still moves to the back of the queue.
				if (due.length > 0) {
					yield* dbExecute((db) =>
						db.run(
							PG.update(StatusPages)
								.set({ publishAttemptedAt: nowMs })
								.where(($) => [
									PG.inList(
										$.id,
										due.map((row) => row.id),
									),
								]),
						),
					)
				}
				const outcomes = yield* Effect.forEach(
					due,
					({ id }) =>
						publish(id).pipe(
							Effect.map((result) =>
								result.written ? ("written" as const) : ("unchanged" as const),
							),
							Effect.catch((error) =>
								Effect.logWarning("Status page publish failed").pipe(
									Effect.annotateLogs({
										"maple.status_page.id": id,
										"error.type": error._tag,
										"error.message": error.message,
									}),
									Effect.as("failed" as const),
								),
							),
						),
					{ concurrency: SWEEP_CONCURRENCY },
				)
				const result: StatusPageSweepResult = {
					due: due.length,
					written: outcomes.filter((o) => o === "written").length,
					unchanged: outcomes.filter((o) => o === "unchanged").length,
					failed: outcomes.filter((o) => o === "failed").length,
					...cleanups,
				}
				// Only after a sweep that reached the database; a store failure here is logged.
				yield* heartbeat(nowMs).pipe(
					Effect.catchTag("@maple/backend/status-pages/StatusPageStoreError", (error) =>
						Effect.logWarning("Status page heartbeat write failed").pipe(
							Effect.annotateLogs({ "error.message": error.message }),
						),
					),
				)
				yield* Effect.annotateCurrentSpan({
					"maple.status_page.due_count": result.due,
					"maple.status_page.written_count": result.written,
					"maple.status_page.failed_count": result.failed,
					"maple.status_page.cleaned_count": result.cleaned,
				})
				return result
			})

			return { publish, sweep, heartbeat }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(StatusPageSnapshotBuilder.layer))
}
