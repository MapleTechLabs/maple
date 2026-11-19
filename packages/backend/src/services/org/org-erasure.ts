import { randomUUID } from "node:crypto"
import * as PG from "@maple-dev/effect-orm/postgres"
import type { MapleDb } from "@maple/db/client"
import { Investigations, OrgErasures, PrReviewReplies, PrReviews, type OrgErasureRow } from "@maple/db/tables"
import { prReplySessionId, prReviewSessionId } from "@maple/domain/chat-session"
import type { OrgErasureKind } from "@maple/domain/org-erasure"
import { WAREHOUSE_ERASURE_TARGETS, warehouseErasureRank } from "@maple/domain/tinybird/org-erasure-plan"
import type { OrgId } from "@maple/primitives"
import { Array as Arr, Clock, Duration, Effect, Option, Schema } from "effect"
import { ChatSessions, ReplayBlobEraser } from "@maple/backend/platform/bindings"
import { Database, type DatabaseApi } from "@maple/backend/platform/DatabaseLive"
import { describeCause } from "@maple/backend/platform/describe-cause"
import { WarehouseDeleteClient } from "@maple/backend/services/warehouse/WarehouseDeleteClient"

/**
 * Erasing what a deleted organization left outside Postgres: its agent conversations (one
 * Durable Object each), its session-replay objects and its warehouse rows. The deletion queues one
 * `org_erasures` row per target before its purge drops the rows that name them; the org-eraser
 * Worker's cron drains them.
 */

/** Where the ingest gateway writes an org's replay chunks (`replayObjectKey`); the slash keeps `org_a` off `org_ab`. */
export const replayPrefix = (orgId: OrgId): string => `v1/${orgId}/`

const INSERT_CHUNK = 500

const insertErasures = (
	db: MapleDb,
	orgId: OrgId,
	now: number,
	targets: ReadonlyArray<readonly [OrgErasureKind, string]>,
) =>
	Effect.forEach(
		Arr.chunksOf(targets, INSERT_CHUNK),
		(chunk) =>
			db.run(
				PG.insertInto(OrgErasures)
					.values(
						Arr.map(chunk, ([kind, target]) => ({
							id: randomUUID(),
							orgId,
							kind,
							target,
							attempts: 0,
							lastError: null,
							nextAttemptAt: now,
							createdAt: now,
						})),
					)
					.onConflictDoNothing(),
			),
		{ discard: true },
	)

/** Queue the erasures that need no rows read: replay prefix and warehouse datasources. Re-queuing is a no-op. */
export const queueOrgErasures = (db: MapleDb, orgId: OrgId, now: number) =>
	Effect.gen(function* () {
		const targets: ReadonlyArray<readonly [OrgErasureKind, string]> = [
			["replay_blobs", replayPrefix(orgId)],
			...Arr.map(WAREHOUSE_ERASURE_TARGETS, (target) => ["warehouse", target.datasource] as const),
		]
		yield* insertErasures(db, orgId, now, targets)
		return targets.length
	})

/** The tables whose rows name a conversation, and the session id each row names. */
const CONVERSATION_TABLES = [
	[Investigations, (orgId: OrgId, id: string) => `${orgId}:inv-${id}`],
	[PrReviews, prReviewSessionId],
	[PrReviewReplies, prReplySessionId],
] as const

/** Whether the purge deletes `table` through {@link purgeConversationRows}. */
export const namesConversations = (table: unknown): boolean =>
	Arr.some(CONVERSATION_TABLES, ([named]) => named === table)

/**
 * Delete the org's rows that name a conversation, queuing each one's erasure in the same
 * transaction: a conversation started while the deletion runs is erased too.
 */
export const purgeConversationRows = (db: MapleDb, table: unknown, orgId: OrgId, now: number) =>
	db.transaction(
		Effect.gen(function* () {
			// Undecoded: a malformed id must still be erased, never fail the deletion.
			const ids =
				table === Investigations
					? yield* db.run(
							PG.deleteFrom(Investigations)
								.where(($) => [$.orgId.eq(orgId)])
								.returning(($) => ({ id: PG.undecoded($.id) })),
						)
					: table === PrReviews
						? yield* db.run(
								PG.deleteFrom(PrReviews)
									.where(($) => [$.orgId.eq(orgId)])
									.returning(($) => ({ id: PG.undecoded($.id) })),
							)
						: yield* db.run(
								PG.deleteFrom(PrReviewReplies)
									.where(($) => [$.orgId.eq(orgId)])
									.returning(($) => ({ id: PG.undecoded($.id) })),
							)
			const sessionOf = Option.getOrElse(
				Option.map(
					Arr.findFirst(CONVERSATION_TABLES, ([named]) => named === table),
					([, session]) => session,
				),
				() => prReplySessionId,
			)
			yield* insertErasures(
				db,
				orgId,
				now,
				Arr.map(ids, (row) => ["chat_session", sessionOf(orgId, row.id)] as const),
			)
			return ids.length
		}),
	)

export class OrgErasureError extends Schema.TaggedError<OrgErasureError>()(
	"@maple/backend/org/OrgErasureError",
	{
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/** Rows one tick takes on; the rest wait for the next. */
const DRAIN_BATCH = 50
/** Replay listing pages one target may delete per tick; a bigger org finishes over later ticks. */
const REPLAY_PAGES_PER_TICK = 20
const SESSION_CONCURRENCY = 4
/** Orgs with warehouse targets one tick looks at; each has one target per OrgId datasource. */
const WAREHOUSE_ORGS = 50
/** Delete jobs in flight at once across every org; the warehouse runs them one by one anyway. */
export const MAX_WAREHOUSE_JOBS = 2
const MAX_BACKOFF = Duration.hours(24)

/** 5 minutes after the first failure, doubling to a day. */
export const erasureBackoffMs = (attempts: number): number =>
	Math.min(
		Duration.toMillis(Duration.minutes(5)) * 2 ** Math.min(attempts, 20),
		Duration.toMillis(MAX_BACKOFF),
	)

type Outcome = "done" | "more"
const DONE: Outcome = "done"
const MORE: Outcome = "more"

const eraseChatSession = (row: OrgErasureRow): Effect.Effect<Outcome, OrgErasureError> =>
	Effect.gen(function* () {
		const sessions = yield* Effect.serviceOption(ChatSessions)
		// No binding means this host never ran a session, so there is nothing to erase.
		if (Option.isNone(sessions)) return DONE
		const erased = yield* sessions.value
			.session(row.target)
			.erase({ sessionId: row.target, orgId: row.orgId })
			.pipe(
				Effect.mapError(
					(error) => new OrgErasureError({ message: error.message, cause: error.cause }),
				),
			)
		if (!erased) {
			return yield* new OrgErasureError({ message: "The session refused the erase", cause: row.target })
		}
		return DONE
	})

const eraseReplayBlobs = (row: OrgErasureRow): Effect.Effect<Outcome, OrgErasureError> =>
	Effect.gen(function* () {
		const eraser = yield* Effect.serviceOption(ReplayBlobEraser)
		if (Option.isNone(eraser)) return DONE
		const deletePage = eraser.value.deletePage
		const loop = (pagesLeft: number): Effect.Effect<Outcome, OrgErasureError> =>
			deletePage(row.target).pipe(
				Effect.mapError(
					(error) => new OrgErasureError({ message: error.message, cause: error.cause }),
				),
				Effect.flatMap((deleted) => {
					if (deleted === 0) return Effect.succeed<Outcome>("done")
					return pagesLeft <= 1 ? Effect.succeed<Outcome>("more") : loop(pagesLeft - 1)
				}),
			)
		return yield* loop(REPLAY_PAGES_PER_TICK)
	})

const setJob = (database: DatabaseApi, id: string, jobId: string | null) =>
	database.execute((db) =>
		db.run(
			PG.update(OrgErasures)
				.set({ jobId })
				.where(($) => [$.id.eq(id)]),
		),
	)

/** Starts the datasource's delete job, then polls it on later ticks until it finishes. */
const eraseWarehouseRows = (row: OrgErasureRow, database: DatabaseApi) =>
	Effect.gen(function* () {
		const client = yield* Effect.serviceOption(WarehouseDeleteClient)
		if (Option.isNone(client)) {
			return yield* new OrgErasureError({
				message: "No warehouse delete client on this host",
				cause: undefined,
			})
		}
		const failed = (error: { readonly message: string; readonly cause: unknown }) =>
			new OrgErasureError({ message: error.message, cause: error.cause })
		if (row.jobId === null) {
			const jobId = yield* client.value.submit(row.target, row.orgId).pipe(Effect.mapError(failed))
			yield* setJob(database, row.id, jobId)
			return MORE
		}
		const state = yield* client.value.status(row.jobId).pipe(Effect.mapError(failed))
		if (state._tag === "Pending") return MORE
		if (state._tag === "Done") return DONE
		// A failed job is started afresh after the backoff.
		yield* setJob(database, row.id, null)
		return yield* new OrgErasureError({ message: state.message, cause: row.jobId })
	})

const eraseTarget = (row: OrgErasureRow, database: DatabaseApi) => {
	switch (row.kind) {
		case "chat_session":
			return eraseChatSession(row)
		case "replay_blobs":
			return eraseReplayBlobs(row)
		case "warehouse":
			return eraseWarehouseRows(row, database)
	}
}

/**
 * The warehouse targets this tick may touch. Every job in flight is polled, whichever org it
 * belongs to. New jobs fill the free slots from a window of orgs with a target due, oldest due
 * first: of each, only due targets of its highest pending rank start, so rollups go before what
 * feeds them.
 */
const warehouseRowsToRun = (database: DatabaseApi, now: number) =>
	Effect.gen(function* () {
		const inFlight = yield* database.execute((db) =>
			db.run(
				PG.from(OrgErasures)
					.select()
					.where(($) => [$.kind.eq("warehouse"), $.jobId.isNotNull()]),
			),
		)
		const slots = Math.max(0, MAX_WAREHOUSE_JOBS - inFlight.length)
		if (slots === 0) return inFlight
		const orgRows = yield* database.execute((db) =>
			db.run(
				PG.from(OrgErasures)
					.select(($) => ({ orgId: $.orgId, firstDue: PG.min($.nextAttemptAt) }))
					.where(($) => [$.kind.eq("warehouse"), $.nextAttemptAt.lte(now), $.jobId.isNull()])
					.groupBy("orgId")
					.orderBy(($) => [
						[PG.min($.nextAttemptAt), "asc"],
						[$.orgId, "asc"],
					])
					.limit(WAREHOUSE_ORGS),
			),
		)
		if (orgRows.length === 0) return inFlight
		const orgs = Arr.map(orgRows, (row) => row.orgId)
		const pending = yield* database.execute((db) =>
			db.run(
				PG.from(OrgErasures)
					.select()
					.where(($) => [$.kind.eq("warehouse"), PG.inList($.orgId, orgs)]),
			),
		)
		const topRank = (orgId: OrgId) =>
			Arr.reduce(
				Arr.filter(pending, (row) => row.orgId === orgId),
				0,
				(top, row) => Math.max(top, warehouseErasureRank(row.target)),
			)
		// In the window's order, so the oldest-due org starts first.
		const fresh = Arr.flatMap(orgs, (orgId) =>
			Arr.filter(
				pending,
				(row) =>
					row.orgId === orgId &&
					row.jobId === null &&
					row.nextAttemptAt <= now &&
					warehouseErasureRank(row.target) === topRank(orgId),
			),
		)
		return [...inFlight, ...Arr.take(fresh, slots)]
	})

/**
 * One drain tick: erase every due target. A finished one loses its row; one with more to delete
 * is due again next tick; a failed erase keeps its error and backs off without stopping the tick.
 */
export const runOrgErasures = Effect.gen(function* () {
	const database = yield* Database
	const now = yield* Clock.currentTimeMillis
	// Warehouse targets apart: many wait on their order, and must not crowd the rest out.
	const others = yield* database.execute((db) =>
		db.run(
			PG.from(OrgErasures)
				.select()
				.where(($) => [$.nextAttemptAt.lte(now), $.kind.neq("warehouse")])
				.orderBy(($) => [[$.nextAttemptAt, "asc"]])
				.limit(DRAIN_BATCH),
		),
	)
	const warehouse = yield* warehouseRowsToRun(database, now)
	const due = [...others, ...warehouse]
	const results = yield* Effect.forEach(
		due,
		(row) =>
			eraseTarget(row, database).pipe(
				// "more" leaves the row due, so the next tick carries on where this one stopped.
				Effect.flatMap((outcome) =>
					outcome === "done"
						? database.execute((db) =>
								db.run(PG.deleteFrom(OrgErasures).where(($) => [$.id.eq(row.id)])),
							)
						: Effect.void,
				),
				Effect.as(true),
				Effect.catchTag("@maple/backend/org/OrgErasureError", (error) =>
					Effect.logWarning("[org-erasure] Erase failed; retrying later").pipe(
						Effect.annotateLogs({
							"maple.org_erasure.kind": row.kind,
							"maple.org_erasure.attempts": row.attempts + 1,
							orgId: row.orgId,
							cause: describeCause(error.cause) ?? "",
						}),
						Effect.andThen(
							database.execute((db) =>
								Effect.gen(function* () {
									const retryAt = now + erasureBackoffMs(row.attempts)
									yield* db.run(
										PG.update(OrgErasures)
											.set({
												attempts: row.attempts + 1,
												lastError: error.message,
												nextAttemptAt: retryAt,
											})
											.where(($) => [$.id.eq(row.id)]),
									)
									// The org's other warehouse targets wait behind this one, so they wait as long.
									if (row.kind !== "warehouse") return
									yield* db.run(
										PG.update(OrgErasures)
											.set({ nextAttemptAt: retryAt })
											.where(($) => [
												$.orgId.eq(row.orgId),
												$.kind.eq("warehouse"),
												$.nextAttemptAt.lt(retryAt),
											]),
									)
								}),
							),
						),
						Effect.as(false),
					),
				),
			),
		{ concurrency: SESSION_CONCURRENCY },
	)
	const failed = Arr.filter(results, (ok) => !ok).length
	yield* Effect.annotateCurrentSpan({
		"maple.org_erasure.due": due.length,
		"maple.org_erasure.failed": failed,
	})
}).pipe(
	Effect.tapCause((cause) =>
		Effect.logError("[org-erasure] drain tick failed").pipe(
			Effect.annotateLogs({ error: String(cause) }),
		),
	),
	Effect.withSpan("OrgErasure.tick"),
)
