import { randomUUID } from "node:crypto"
import * as PG from "@maple-dev/effect-orm/postgres"
import type { MapleDb } from "@maple/db/client"
import { Investigations, OrgErasures, PrReviewReplies, PrReviews, type OrgErasureRow } from "@maple/db/tables"
import { prReplySessionId, prReviewSessionId } from "@maple/domain/chat-session"
import type { OrgErasureKind } from "@maple/domain/org-erasure"
import type { OrgId } from "@maple/primitives"
import { Array as Arr, Clock, Duration, Effect, Option, Schema } from "effect"
import { ChatSessions, ReplayBlobEraser } from "@maple/backend/platform/bindings"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { describeCause } from "@maple/backend/platform/describe-cause"

/**
 * Erasing what a deleted organization left outside Postgres: its agent conversations (one
 * Durable Object each) and its session-replay objects. The deletion queues one `org_erasures` row
 * per target before its purge drops the rows that name them; the api's hourly cron drains them.
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

/** Queue the erasures that need no rows read: the org's replay prefix. Re-queuing is a no-op. */
export const queueOrgErasures = (db: MapleDb, orgId: OrgId, now: number) =>
	Effect.gen(function* () {
		const targets: ReadonlyArray<readonly [OrgErasureKind, string]> = [
			["replay_blobs", replayPrefix(orgId)],
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
const MAX_BACKOFF = Duration.hours(24)

/** 5 minutes after the first failure, doubling to a day. */
export const erasureBackoffMs = (attempts: number): number =>
	Math.min(
		Duration.toMillis(Duration.minutes(5)) * 2 ** Math.min(attempts, 20),
		Duration.toMillis(MAX_BACKOFF),
	)

type Outcome = "done" | "more"
const DONE: Outcome = "done"

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

const eraseTarget = (row: OrgErasureRow) =>
	row.kind === "chat_session" ? eraseChatSession(row) : eraseReplayBlobs(row)

/**
 * One drain tick: erase every due target. A finished one loses its row; one with more to delete
 * is due again next tick; a failed erase keeps its error and backs off without stopping the tick.
 */
export const runOrgErasures = Effect.gen(function* () {
	const database = yield* Database
	const now = yield* Clock.currentTimeMillis
	const due = yield* database.execute((db) =>
		db.run(
			PG.from(OrgErasures)
				.select()
				.where(($) => [$.nextAttemptAt.lte(now)])
				.orderBy(($) => [[$.nextAttemptAt, "asc"]])
				.limit(DRAIN_BATCH),
		),
	)
	const results = yield* Effect.forEach(
		due,
		(row) =>
			eraseTarget(row).pipe(
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
								db.run(
									PG.update(OrgErasures)
										.set({
											attempts: row.attempts + 1,
											lastError: error.message,
											nextAttemptAt: now + erasureBackoffMs(row.attempts),
										})
										.where(($) => [$.id.eq(row.id)]),
								),
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
