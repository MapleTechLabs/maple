/**
 * The lease and watermark rows in `planetscale_poll_state`, one per (org, dataset, database).
 * Every PlanetScale poller claims its work here, so overlapping cron ticks never run the same
 * dataset twice and a failed run never advances a watermark.
 */
import { randomUUID } from "node:crypto"
import { IntegrationsPersistenceError, type OrgId } from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { leaseStillOurs } from "../lease"
import { leaseFree, type LeaseSpec } from "../poller"
import { PlanetscalePollState } from "@maple/db/tables"
import { Duration, Effect, Array as Arr } from "effect"
import type { DatabaseApi } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"

/** The metrics API poller's org-wide row (`databaseId` ""), whose watermark is its last window. */
export const PLANETSCALE_METRICS_DATASET = "metrics"

export type UnclaimedReason = "disabled" | "fresh" | "held" | "lease_held"

/**
 * A claimed row's result, written through the lease. Advancing `watermarkAt` only on success is
 * what keeps a failed page from being skipped forever.
 */
export const pollStateResult = (
	now: number,
	error: string | null,
	watermarkAt: number | null = null,
): PG.UpdateSetOf<typeof PlanetscalePollState> =>
	error === null
		? {
				lastSuccessAt: now,
				lastError: null,
				lastErrorAt: null,
				updatedAt: now,
				...(watermarkAt === null ? undefined : { watermarkAt }),
			}
		: { lastError: error, lastErrorAt: now, updatedAt: now }

/** Tick-overlap lease. */
const LEASE_MS = Duration.toMillis(Duration.minutes(4))

const toPersistenceError = makePersistenceErrorMapper(
	IntegrationsPersistenceError,
	"PlanetScale poll state persistence failed",
)

export const makePlanetScalePollState = (database: DatabaseApi, service: string) => {
	const dbExecute = makeDbExecute(database, service, toPersistenceError)

	/** `databaseId → lastSuccessAt`, for round-robining a budgeted sweep. */
	const pollStateByDatabaseId = Effect.fn("PlanetScalePollState.pollStateByDatabaseId")(function* (
		orgId: OrgId,
		dataset: string,
	) {
		const rows = yield* dbExecute((db) =>
			db.run(
				PG.from(PlanetscalePollState)
					.select("databaseId", "lastSuccessAt")
					.where(($) => [$.orgId.eq(orgId), $.dataset.eq(dataset)]),
			),
		)
		return new Map(Arr.map(rows, (row) => [row.databaseId, row.lastSuccessAt]))
	})

	/**
	 * Why `pollStateLease` did not claim the row: polling disabled, data still fresh, a failure's
	 * hold, or another tick's lease. The caller puts it on its span.
	 */
	const unclaimedReason = (
		orgId: OrgId,
		dataset: string,
		databaseId: string,
		freshMs: number,
		now: number,
	) =>
		dbExecute((db) =>
			db.run(
				PG.from(PlanetscalePollState)
					.select("enabled", "lastSuccessAt", "holdUntil")
					.where(($) => [$.orgId.eq(orgId), $.dataset.eq(dataset), $.databaseId.eq(databaseId)])
					.limit(1),
			),
		).pipe(
			Effect.map(([row]): UnclaimedReason => {
				if (row === undefined) return "lease_held"
				if (!row.enabled) return "disabled"
				if (row.lastSuccessAt !== null && now - row.lastSuccessAt < freshMs) return "fresh"
				if (row.holdUntil !== null && row.holdUntil > now) return "held"
				return "lease_held"
			}),
		)

	/**
	 * The (org, dataset, database) row as a {@link LeaseSpec}: created on first use, claimed while
	 * enabled, past `freshMs` since its last success, and free of a lease or hold.
	 */
	const pollStateLease = (
		orgId: OrgId,
		dataset: string,
		databaseId: string,
		freshMs: number,
	): LeaseSpec<
		PG.SelectRowOf<typeof PlanetscalePollState>,
		PG.UpdateSetOf<typeof PlanetscalePollState>,
		IntegrationsPersistenceError
	> => ({
		leaseMs: LEASE_MS,
		claim: (leaseUntil, now) =>
			dbExecute((db) =>
				Effect.gen(function* () {
					yield* db.run(
						PG.insertInto(PlanetscalePollState)
							.values({
								id: randomUUID(),
								orgId,
								dataset,
								databaseId,
								createdAt: now,
								updatedAt: now,
							})
							.onConflictDoNothing({ target: ["orgId", "dataset", "databaseId"] }),
					)
					const rows = yield* db.run(
						PG.update(PlanetscalePollState)
							.set({ leaseUntil, updatedAt: now })
							.where(($) => [
								$.orgId.eq(orgId),
								$.dataset.eq(dataset),
								$.databaseId.eq(databaseId),
								$.enabled.eq(true),
								PG.or($.lastSuccessAt.isNull(), $.lastSuccessAt.lte(now - freshMs)),
								leaseFree($.leaseUntil, $.holdUntil, now, LEASE_MS),
							])
							.returning(),
					)
					return rows[0] ?? null
				}),
			),
		write: (claimed, set) =>
			dbExecute((db) =>
				db.run(
					PG.update(PlanetscalePollState)
						.set(set)
						.where(($) => [$.id.eq(claimed.id), leaseStillOurs($.leaseUntil, claimed.leaseUntil)])
						.returning("id"),
				),
			).pipe(Effect.map((rows) => rows.length > 0)),
		release: (holdUntil, now) => ({ leaseUntil: null, holdUntil, updatedAt: now }),
	})

	return { pollStateByDatabaseId, pollStateLease, unclaimedReason }
}
