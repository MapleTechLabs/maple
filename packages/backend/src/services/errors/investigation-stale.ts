/**
 * When a run that still says `investigating` has been abandoned.
 *
 * One module because it used to live in two and they drifted. Both the
 * incident-open path and `InvestigationService` import from here.
 */
import { investigations } from "@maple/db"
import type { MapleDbLike } from "@maple/db/client"
import { and, eq, lt } from "drizzle-orm"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import { Effect } from "effect"
import { msToDate } from "@maple/backend/platform/time"

/** One agent pass. If it has not answered in this long, it is not going to. */
export const STALE_MS = 15 * 60 * 1000

export const staleTimeoutMessage = (budgetMs: number): string =>
	`diagnosis_timeout: no diagnosis was submitted within ${Math.round(budgetMs / 60_000)} minutes; retry`

/** True when this row has outlived the pass budget. */
export const isInvestigationStale = (
	row: { readonly status: string; readonly startedAt: Date | null },
	nowMs: number,
): boolean =>
	row.status === "investigating" && row.startedAt !== null && row.startedAt.getTime() < nowMs - STALE_MS

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
				),
			)
			.returning({ id: investigations.id }),
		(rows) => rows.length,
	)
