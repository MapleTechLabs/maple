/**
 * When a run that still says `investigating` has been abandoned.
 *
 * One module because it used to live in two and they drifted. Both the
 * incident-open path and `InvestigationService` import from here.
 */
import * as PG from "@maple-dev/effect-orm/postgres"
import type { MapleDb, MapleDbError } from "@maple/db/client"
import { Investigations, type InvestigationRow } from "@maple/db/tables"
import type { OrgId } from "@maple/domain/http"
import { Effect, Option, Schema } from "effect"

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

const decodeHeartbeat = Schema.decodeUnknownOption(Schema.Struct({ updatedAt: Schema.Number }))

/**
 * `progress_json` as stored, selected without its schema: a malformed progress record must not
 * fail the read that only wants to know whether the run is alive.
 */
export const storedProgressJson = ($: PG.ColumnAccessor<typeof Investigations.columns>) =>
	PG.undecoded($.progressJson)

export const staleTimeoutMessage = (budgetMs: number): string =>
	`diagnosis_timeout: no diagnosis was submitted within ${Math.round(budgetMs / 60_000)} minutes; retry`

/** True when this row has outlived the pass budget and is not still reporting steps. */
export const isInvestigationStale = (
	row: {
		readonly status: string
		readonly startedAt: number | null
		/** Stored progress, possibly undecoded; only its `updatedAt` is read. */
		readonly progressJson?: unknown
	},
	nowMs: number,
): boolean => {
	if (row.status !== "investigating") return false
	if (row.startedAt === null || row.startedAt >= nowMs - STALE_MS) return false
	const heartbeat = Option.getOrUndefined(decodeHeartbeat(row.progressJson))?.updatedAt
	return heartbeat === undefined || heartbeat < nowMs - PROGRESS_HEARTBEAT_STALE_MS
}

/**
 * Fail abandoned runs: every org in one statement for the tick, or one org when a read finds a
 * stale row on its page. The only sweep; there used to be a second, per-org one that ignored
 * the heartbeat and failed live passes in their close-out.
 *
 * Until this existed the check ran only when something happened to read the row: a detail page
 * load, or a second incident on the same subject re-enqueueing. An autonomous run nobody opens is
 * exactly the run nobody reads, so a pass whose Durable Object died left the row saying
 * `investigating` indefinitely and the hub filled with investigations that were never coming back.
 * Prod, 2026-09-19: 78 of 100 starts left no trace at all.
 *
 * Mirrors {@link isInvestigationStale}, heartbeat included: a run still recording steps is alive
 * however long it has been going. `coalesce` to zero so a row whose progress somehow carries no
 * `updatedAt` reads as no heartbeat and is still swept, rather than a NULL comparison quietly
 * excluding it forever. Guarded on `investigating`, so a run that settled meanwhile is untouched.
 *
 * Returns the rows it moved, so callers can settle their anomaly triage and the tick can report
 * a count that should normally be zero.
 */
export const sweepAbandonedInvestigations = (
	orm: MapleDb,
	nowMs: number,
	orgId?: OrgId,
): Effect.Effect<ReadonlyArray<Pick<InvestigationRow, "incidentKind" | "incidentId">>, MapleDbError> =>
	orm.run(
		PG.update(Investigations)
			.set({
				status: "failed",
				error: staleTimeoutMessage(STALE_MS),
				updatedAt: nowMs,
			})
			.where(($) => [
				orgId === undefined ? undefined : $.orgId.eq(orgId),
				$.status.eq("investigating"),
				$.startedAt.lt(nowMs - STALE_MS),
				PG.or(
					$.progressJson.isNull(),
					PG.sql
						.cond`coalesce((${$.progressJson}->>'updatedAt')::bigint, 0) < ${nowMs - PROGRESS_HEARTBEAT_STALE_MS}`,
				),
			])
			.returning("incidentKind", "incidentId"),
	)
