import * as PG from "@maple-dev/effect-orm/postgres"
import { StatusPages } from "@maple/db/tables"
import type { StatusPageId } from "@maple/domain/primitives"
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
const SWEEP_CONCURRENCY = 4

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
}

export type StatusPagePublishError = StatusPageGoneError | StatusPagePublishDbError | StatusPageStoreError

export interface StatusPagePublisherApi {
	readonly publish: (pageId: StatusPageId) => Effect.Effect<StatusPagePublishResult, StatusPagePublishError>
	/** Publishes pages whose revision lags or whose last publish is stale; a failing page is logged and skipped. */
	readonly sweep: (nowMs: number) => Effect.Effect<StatusPageSweepResult, StatusPagePublishDbError>
	readonly heartbeat: (nowMs: number) => Effect.Effect<void, StatusPageStoreError>
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

			const recordFailure = (pageId: StatusPageId, error: StatusPageStoreError) =>
				dbExecute((db) =>
					db.run(
						PG.update(StatusPages)
							.set({ lastPublishError: error.message })
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
								slug: $.slug,
								revision: $.revision,
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
						Effect.catch((error) => recordFailure(pageId, error)),
					)
				}
				const advanced = yield* dbExecute((db) =>
					db.run(
						PG.update(StatusPages)
							.set({
								publishedRevision: revision,
								publishedAt: nowMs,
								publishedHash: hash,
								lastPublishError: null,
							})
							.where(($) => [$.id.eq(pageId), $.publishedRevision.lt(revision)])
							.returning("id"),
					),
				)
				if (advanced.length === 0) {
					// A concurrent publish got further; ours may have overwritten its snapshot, so go again.
					yield* dbExecute((db) =>
						db.run(
							PG.update(StatusPages)
								.set({ publishedAt: nowMs, lastPublishError: null })
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

			const sweep = Effect.fn("StatusPagePublisher.sweep")(function* (nowMs: number) {
				const staleBefore = nowMs - STATUS_PAGE_REPUBLISH_AFTER_MS
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
							.orderBy(["id", "asc"])
							.limit(STATUS_PAGE_SWEEP_BATCH),
					),
				)
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
				}
				yield* Effect.annotateCurrentSpan({
					"maple.status_page.due_count": result.due,
					"maple.status_page.written_count": result.written,
					"maple.status_page.failed_count": result.failed,
				})
				return result
			})

			const heartbeat = Effect.fn("StatusPagePublisher.heartbeat")(function* (nowMs: number) {
				yield* store.putHeartbeat(nowMs)
			})

			return { publish, sweep, heartbeat }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(StatusPageSnapshotBuilder.layer))
}
