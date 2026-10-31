/**
 * The lease and watermark rows in `planetscale_poll_state`, one per (org, dataset, database).
 * Every PlanetScale poller claims its work here, so overlapping cron ticks never run the same
 * dataset twice and a failed run never advances a watermark.
 */
import { randomUUID } from "node:crypto"
import { IntegrationsPersistenceError, type OrgId } from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { PlanetscalePollState } from "@maple/db/tables"
import { Clock, Duration, Effect } from "effect"
import type { DatabaseApi } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"

/** The metrics API poller's org-wide row (`databaseId` ""), whose watermark is its last window. */
export const PLANETSCALE_METRICS_DATASET = "metrics"

/** Tick-overlap lease. */
const LEASE_MS = Duration.toMillis(Duration.minutes(4))

const toPersistenceError = (error: unknown) =>
	new IntegrationsPersistenceError({
		message: error instanceof Error ? error.message : "PlanetScale poll state persistence failed",
	})

export const makePlanetScalePollState = (database: DatabaseApi, service: string) => {
	const dbExecute = makeDbExecute(database, service, toPersistenceError)

	/**
	 * Claim a dataset row for this tick. A non-"claimed" outcome says why the
	 * work was skipped (polling disabled, data still fresh, or another tick holds
	 * the lease), so the caller can put the reason on its span.
	 */
	const claimPollWork = Effect.fn("PlanetScalePollState.claimPollWork")(function* (
		orgId: OrgId,
		dataset: string,
		databaseId: string,
		ttlMs: number,
	) {
		const now = yield* Clock.currentTimeMillis
		const rows = yield* dbExecute((db) =>
			db.run(
				PG.from(PlanetscalePollState)
					.select()
					.where(($) => [$.orgId.eq(orgId), $.dataset.eq(dataset), $.databaseId.eq(databaseId)])
					.limit(1),
			),
		)
		const existing = rows[0]

		if (existing === undefined) {
			yield* dbExecute((db) =>
				db.run(
					PG.insertInto(PlanetscalePollState).values({
						id: randomUUID(),
						orgId,
						dataset,
						databaseId,
						leaseUntil: now + LEASE_MS,
						createdAt: now,
						updatedAt: now,
					}),
				),
			)
			return "claimed" as const
		}

		if (!existing.enabled) return "disabled" as const
		if (existing.lastSuccessAt !== null && now - existing.lastSuccessAt < ttlMs) {
			return "fresh" as const
		}

		// Lease claim: only wins if the previous lease expired. `.returning()`
		// length is the claim signal (never read driver write-result shapes).
		const claimed = yield* dbExecute((db) =>
			db.run(
				PG.update(PlanetscalePollState)
					.set({ leaseUntil: now + LEASE_MS, updatedAt: now })
					.where(($) => [$.id.eq(existing.id), PG.or($.leaseUntil.isNull(), $.leaseUntil.lt(now))])
					.returning("id"),
			),
		)
		return claimed.length > 0 ? ("claimed" as const) : ("lease_held" as const)
	})

	const readPollState = Effect.fn("PlanetScalePollState.readPollState")(function* (
		orgId: OrgId,
		dataset: string,
		databaseId: string,
	) {
		const rows = yield* dbExecute((db) =>
			db.run(
				PG.from(PlanetscalePollState)
					.select()
					.where(($) => [$.orgId.eq(orgId), $.dataset.eq(dataset), $.databaseId.eq(databaseId)])
					.limit(1),
			),
		)
		return rows[0]
	})

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
		return new Map(rows.map((row) => [row.databaseId, row.lastSuccessAt]))
	})

	/**
	 * Release a non-inventory dataset row. Advancing `watermarkAt` only on
	 * success is what keeps a failed page from being skipped forever.
	 */
	const recordPollResult = Effect.fn("PlanetScalePollState.recordPollResult")(function* (
		orgId: OrgId,
		dataset: string,
		databaseId: string,
		error: string | null,
		watermarkAt: number | null,
	) {
		const now = yield* Clock.currentTimeMillis
		yield* dbExecute((db) =>
			db.run(
				PG.update(PlanetscalePollState)
					.set(
						error === null
							? {
									lastSuccessAt: now,
									lastError: null,
									lastErrorAt: null,
									leaseUntil: null,
									updatedAt: now,
									...(!(watermarkAt === null) ? { watermarkAt } : undefined),
								}
							: {
									lastError: error,
									lastErrorAt: now,
									leaseUntil: null,
									updatedAt: now,
								},
					)
					.where(($) => [$.orgId.eq(orgId), $.dataset.eq(dataset), $.databaseId.eq(databaseId)]),
			),
		)
	})

	return { claimPollWork, readPollState, pollStateByDatabaseId, recordPollResult }
}
