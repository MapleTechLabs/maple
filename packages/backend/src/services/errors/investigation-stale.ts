/**
 * When a run that still says `investigating` has been abandoned.
 *
 * One module because it used to live in two and they drifted. Both the
 * incident-open path and `InvestigationService` import from here.
 */
import { investigations } from "@maple/db"
import type { MapleDbLike } from "@maple/db/client"
import { and, eq, isNull, lt, or, sql } from "drizzle-orm"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import { Effect } from "effect"
import { msToDate } from "@maple/backend/platform/time"

/** One agent pass. If it has not answered in this long, it is not going to. */
export const STALE_MS = 15 * 60 * 1000

/**
 * How long a run may go without recording a step before its heartbeat stops meaning "alive".
 *
 * `startedAt` alone cannot answer this. `recordProgress` deliberately leaves `updated_at` alone,
 * because the hub sorts on it and a heartbeat every eight seconds would walk a running row up the
 * list under the reader, so `progress_json.updatedAt` is the only liveness signal the row carries.
 * A pass gets ten minutes and its close-out is a second run with its own ten, so a run doing
 * exactly what it should can still be alive past {@link STALE_MS} and was being failed underneath
 * itself.
 *
 * Five minutes rather than something near the eight-second flush: progress records tool calls, and
 * a model that reasons for a while between them is working, not gone. It only ever *protects* a
 * row, since the `startedAt` floor still has to be crossed first, so being generous here cannot
 * leave a dead row investigating forever.
 */
export const PROGRESS_HEARTBEAT_STALE_MS = 5 * 60 * 1000

export const staleTimeoutMessage = (budgetMs: number): string =>
	`diagnosis_timeout: no diagnosis was submitted within ${Math.round(budgetMs / 60_000)} minutes; retry`

/** True when this row has outlived the pass budget and is not still reporting steps. */
export const isInvestigationStale = (
	row: {
		readonly status: string
		readonly startedAt: Date | null
		readonly progressJson?: { readonly updatedAt: number } | null
	},
	nowMs: number,
): boolean => {
	if (row.status !== "investigating") return false
	if (row.startedAt === null || row.startedAt.getTime() >= nowMs - STALE_MS) return false
	const heartbeat = row.progressJson?.updatedAt
	return heartbeat === undefined || heartbeat < nowMs - PROGRESS_HEARTBEAT_STALE_MS
}

/**
 * Fail every abandoned run, across every org, in one statement.
 *
 * Until this existed the check ran only when something happened to read the row: a detail page
 * load, or a second incident on the same subject re-enqueueing. An autonomous run nobody opens is
 * exactly the run nobody reads, so a pass whose Durable Object died left the row saying
 * `investigating` indefinitely and the hub filled with investigations that were never coming back.
 * Prod, 2026-09-19: 78 of 100 starts left no trace at all.
 *
 * Org-agnostic and unbatched on purpose. The per-org form would be one round-trip per org per tick
 * against a table where the matching set is almost always empty; this is one statement for the
 * whole tick, and `status` narrows it before `started_at` does.
 *
 * Mirrors {@link isInvestigationStale}, heartbeat included: a run still recording steps is alive
 * however long it has been going, and a sweep that ran every tick rather than on a read would
 * otherwise fail a pass in its close-out. `coalesce` to zero so a row whose progress somehow
 * carries no `updatedAt` reads as no heartbeat and is still swept, rather than a NULL comparison
 * quietly excluding it forever.
 *
 * Returns how many rows it moved so the tick can report a number that should normally be zero.
 */
export const sweepAbandonedInvestigations = (
	db: MapleDbLike,
	nowMs: number,
): Effect.Effect<number, EffectDrizzleQueryError> =>
	Effect.map(
		db
			.update(investigations)
			.set({
				status: "failed",
				error: staleTimeoutMessage(STALE_MS),
				updatedAt: msToDate(nowMs),
			})
			.where(
				and(
					eq(investigations.status, "investigating"),
					lt(investigations.startedAt, msToDate(nowMs - STALE_MS)),
					or(
						isNull(investigations.progressJson),
						sql`coalesce((${investigations.progressJson}->>'updatedAt')::bigint, 0) < ${nowMs - PROGRESS_HEARTBEAT_STALE_MS}`,
					),
				),
			)
			.returning({ id: investigations.id }),
		(rows) => rows.length,
	)
