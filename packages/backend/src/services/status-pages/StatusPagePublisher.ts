import * as PG from "@maple-dev/effect-orm/postgres"
import { StatusPageCleanups, StatusPageCustomDomains, StatusPages } from "@maple/db/tables"
import type { StatusPageCleanupRow } from "@maple/db/tables"
import type { StatusPageId } from "@maple/primitives"
import { Clock, Context, Effect, Layer, Schema, Array as Arr, String as Str } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { CloudflareCustomHostnames } from "./CloudflareCustomHostnames"
import { bumpPage } from "./outbox"
import { StatusPageGoneError, StatusPagePublishDbError } from "./publish-errors"
import { StatusPageSnapshotBuilder } from "./StatusPageSnapshotBuilder"
import { StatusPageStore, StatusPageStoreError } from "./StatusPageStore"

/** Pages published longer ago than this are republished so bars and freshness roll. */
export const STATUS_PAGE_REPUBLISH_AFTER_MS = 15 * 60_000
/** Pages one sweep publishes at most; the rest wait for the next minute. */
export const STATUS_PAGE_SWEEP_BATCH = 100
/** Edge cleanups one sweep drains at most, oldest first. */
export const STATUS_PAGE_CLEANUP_BATCH = 50
const SWEEP_CONCURRENCY = 4

export interface StatusPagePublishResult {
	readonly pageId: StatusPageId
	readonly revision: number
	/** False when the content matched the last publish, or the page is a draft, and nothing was written. */
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
	/**
	 * A draft page is a no-op: nothing reaches the edge until it is made public. An internal page
	 * is taken off the edge instead: its slug route and snapshot go.
	 */
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

// Encoding a built snapshot cannot fail, so a failure is a defect.
const encodeJson = (value: unknown) =>
	Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(Effect.orDie)

const toHex = (buffer: ArrayBuffer) =>
	Arr.join(
		Array.from(new Uint8Array(buffer), (byte) => Str.padStart(2, "0")(byte.toString(16))),
		"",
	)

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
			const customHostnames = yield* CloudflareCustomHostnames
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
								draft: $.draft,
								visibility: $.visibility,
								slug: $.slug,
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
				if (current.draft) {
					yield* Effect.annotateCurrentSpan({ "maple.status_page.draft": true })
					return { pageId, revision: current.revision, written: false }
				}
				const nowMs = yield* Clock.currentTimeMillis
				if (current.visibility === "internal") {
					yield* Effect.annotateCurrentSpan({ "maple.status_page.visibility": "internal" })
					yield* unpublish(pageId, current.slug).pipe(
						Effect.catch((error) => recordFailure(pageId, nowMs, error)),
					)
					// A lost race leaves the revision ahead, so the next sweep takes the page off again.
					yield* dbExecute((db) =>
						db.run(
							PG.update(StatusPages)
								.set({
									publishedRevision: current.revision,
									publishedAt: nowMs,
									// Made public again, the page must be written even if nothing else changed.
									publishedHash: null,
									publishAttemptedAt: nowMs,
									lastPublishError: null,
								})
								.where(($) => [
									$.id.eq(pageId),
									$.publishedRevision.eq(current.publishedRevision),
								]),
						),
					)
					return { pageId, revision: current.revision, written: false }
				}
				const snapshot = yield* builder.build(pageId, nowMs)
				// The read revision, not the build's: a bump during the build republishes next sweep.
				const revision = current.revision
				// What a visitor sees: a bump or a stale republish with no visible change writes nothing.
				const contentJson = yield* encodeJson({ ...snapshot, generatedAt: 0, revision: 0 })
				const hash = yield* sha256Hex(contentJson)
				const written = hash !== current.publishedHash
				// An active custom domain routes here too; the snapshot carries it, so its hash covers it.
				const customDomain = snapshot.page.customDomain
				const routes = {
					slug: snapshot.page.slug,
					hostnames: customDomain === null ? [] : [customDomain],
				}
				if (written) {
					const snapshotJson = yield* encodeJson(snapshot)
					yield* store.putSnapshot(pageId, snapshotJson).pipe(
						Effect.andThen(store.putRoutes(pageId, routes)),
						Effect.catch((error) => recordFailure(pageId, nowMs, error)),
					)
				}
				// The hash covers content only, so a route lost at the edge is checked for on its own.
				const reroutedOnly = written
					? false
					: yield* Effect.all([
							store.readSlugRoute(routes.slug),
							customDomain === null ? Effect.succeed(pageId) : store.readHostRoute(customDomain),
						]).pipe(
							Effect.flatMap(([slugTo, hostTo]) =>
								slugTo === pageId && hostTo === pageId
									? Effect.succeed(false)
									: store.putRoutes(pageId, routes).pipe(Effect.as(true)),
							),
							Effect.catch((error) => recordFailure(pageId, nowMs, error)),
						)
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
					// A concurrent publish got further; ours may have overwritten its snapshot or put back
					// routes it took down (the page went internal), so go again.
					// Clearing the hash makes that next publish rewrite the body even if it builds the same.
					const [still] = yield* dbExecute((db) =>
						db.run(
							PG.update(StatusPages)
								.set({
									publishedAt: nowMs,
									publishAttemptedAt: nowMs,
									lastPublishError: null,
									...(written ? { publishedHash: null } : undefined),
								})
								.where(($) => [$.id.eq(pageId)])
								.returning("id"),
						),
					)
					if (still === undefined) {
						// Deleted mid-publish, maybe after its cleanup drained: take back what we wrote.
						if (written)
							yield* cleanEdge({
								pageId,
								slug: routes.slug,
								deleteSnapshot: true,
								hostname: customDomain,
								cloudflareHostnameId: null,
								cloudflareRouteId: null,
							})
						return yield* new StatusPageGoneError({
							message: `Status page ${pageId} not found`,
							pageId,
						})
					}
					if (written || reroutedOnly) yield* dbExecute((db) => bumpPage(db, current.orgId, pageId))
				}
				yield* Effect.annotateCurrentSpan({
					"maple.status_page.revision": revision,
					"maple.status_page.written": written,
				})
				return { pageId, revision, written }
			})

			/** Takes an internal page off the edge: its slug route while it still names the page, and its snapshot. */
			const unpublish = (pageId: StatusPageId, slug: string) =>
				store.readSlugRoute(slug).pipe(
					Effect.flatMap((routedTo) =>
						routedTo === pageId ? store.deleteRoutes({ slug, hostnames: [] }) : Effect.void,
					),
					Effect.andThen(store.deleteSnapshot(pageId)),
				)

			/**
			 * Removes one cleanup's edge data; a slug or hostname another live page now uses is left alone.
			 * A page that still exists keeps its snapshot: its delete never committed (an org purge that
			 * failed later on).
			 */
			const cleanEdge = (
				row: Pick<
					StatusPageCleanupRow,
					| "pageId"
					| "slug"
					| "deleteSnapshot"
					| "hostname"
					| "cloudflareHostnameId"
					| "cloudflareRouteId"
				>,
			) =>
				Effect.gen(function* () {
					const alive = yield* dbExecute((db) =>
						db.run(
							PG.from(StatusPages)
								.select(($) => ({ id: $.id }))
								.where(($) => [$.id.eq(row.pageId)])
								.limit(1),
						),
					)
					if (row.slug !== null) {
						const slug = row.slug
						const owners = yield* dbExecute((db) =>
							db.run(
								PG.from(StatusPages)
									.select(($) => ({ id: $.id }))
									.where(($) => [$.slug.eq(slug)])
									.limit(1),
							),
						)
						const routedTo = yield* store.readSlugRoute(slug)
						const slugIsOurs =
							owners.length === 0 && (routedTo === null || routedTo === row.pageId)
						if (slugIsOurs) yield* store.deleteRoutes({ slug, hostnames: [] })
					}
					if (row.hostname !== null) yield* cleanCustomDomain({ ...row, hostname: row.hostname })
					if (row.deleteSnapshot && alive.length === 0) yield* store.deletePage(row.pageId)
				})

			/**
			 * Takes a removed custom domain down: its Cloudflare route and hostname, then its edge route.
			 * A hostname a live page claims again keeps its edge route, and keeps the Cloudflare pieces
			 * that page took over. Without Cloudflare configured here the edge route still goes.
			 */
			const cleanCustomDomain = (row: {
				readonly pageId: StatusPageId
				readonly hostname: string
				readonly cloudflareHostnameId: string | null
				readonly cloudflareRouteId: string | null
			}) =>
				Effect.gen(function* () {
					const [claimed] = yield* dbExecute((db) =>
						db.run(
							PG.from(StatusPageCustomDomains)
								.select(($) => ({
									cloudflareHostnameId: $.cloudflareHostnameId,
									cloudflareRouteId: $.cloudflareRouteId,
								}))
								.where(($) => [$.hostname.eq(row.hostname)])
								.limit(1),
						),
					)
					const cloudflare = Effect.all(
						[
							row.cloudflareRouteId === null ||
							claimed?.cloudflareRouteId === row.cloudflareRouteId
								? Effect.void
								: customHostnames.deleteRoute(row.cloudflareRouteId),
							row.cloudflareHostnameId === null ||
							claimed?.cloudflareHostnameId === row.cloudflareHostnameId
								? Effect.void
								: customHostnames.deleteHostname(row.cloudflareHostnameId),
						],
						{ discard: true },
					)
					yield* cloudflare.pipe(
						Effect.catchTag("@maple/backend/status-pages/CustomHostnamesNotConfiguredError", () =>
							Effect.logWarning(
								"Custom domain left at Cloudflare: custom domains are not configured",
							).pipe(Effect.annotateLogs({ "maple.status_page.custom_domain": row.hostname })),
						),
						Effect.mapError(
							(error) =>
								new StatusPageStoreError({
									message: error.message,
									operation: "cloudflare.delete",
									key: row.hostname,
									cause: error,
								}),
						),
					)
					// Only a route still at the removed page goes: a claimer that already published keeps its own.
					const routedTo = yield* store.readHostRoute(row.hostname)
					if (routedTo === null || routedTo === row.pageId)
						yield* store.deleteHostRoute(row.hostname)
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
					cleaned: Arr.filter(outcomes, (ok) => ok).length,
					cleanupsFailed: Arr.filter(outcomes, (ok) => !ok).length,
				}
			})

			const heartbeat = Effect.fn("StatusPagePublisher.heartbeat")(function* (nowMs: number) {
				const probesSeenAt = yield* builder.probesSeenAt(nowMs)
				yield* store.putHeartbeat({ at: nowMs, probesSeenAt })
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
								$.draft.eq(false),
								// An internal page has nothing at the edge to refresh, only a change to take down.
								PG.or(
									$.revision.gt($.publishedRevision),
									PG.and(
										$.visibility.neq("internal"),
										PG.or($.publishedAt.isNull(), $.publishedAt.lt(staleBefore)),
									),
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
										Arr.map(due, (row) => row.id),
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
					written: Arr.filter(outcomes, (o) => o === "written").length,
					unchanged: Arr.filter(outcomes, (o) => o === "unchanged").length,
					failed: Arr.filter(outcomes, (o) => o === "failed").length,
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
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(StatusPageSnapshotBuilder.layer, CloudflareCustomHostnames.layer)),
	)
}
