import * as PG from "@maple-dev/effect-orm/postgres"
import { PlanetscaleEvents, PlanetscaleIssueReceipts } from "@maple/db/tables"
import { Clock, Effect } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"

/**
 * Retention for the PlanetScale lifecycle timeline (`planetscale_events`).
 *
 * The table is small by design — tens of rows per org per day — but it is
 * append-only from two sources with no upper bound, and a 30-day REST backfill
 * on a busy org can land thousands of rows at once. Two limits, mirroring
 * `scrape-check-retention.ts`: an age cutoff that matches how far back the
 * charts are useful, and a per-org row cap as a backstop.
 *
 * Runs from the API worker's existing hourly retention cron rather than its own
 * schedule — every new cron string costs an entry in `alchemy.run.ts` and a
 * branch in `worker.ts`, and this has no reason to tick on a different beat.
 */

/** Age cutoff. Beyond this a deploy marker has no chart left to sit on. */
const EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

/** Per-org backstop against a pathological webhook loop or a huge backfill. */
const EVENT_MAX_ROWS_PER_ORG = 20_000

/**
 * Apply retention. Every statement runs inside ONE `execute`: one span, one
 * logical call on the invocation's connection.
 */
export const runPlanetScaleEventRetention = Effect.gen(function* () {
	const now = yield* Clock.currentTimeMillis
	const cutoff = now - EVENT_RETENTION_MS
	const database = yield* Database

	const { orgs, deletedByAge, deletedReceipts } = yield* database.execute((db) =>
		Effect.gen(function* () {
			// A bounded indexed sweep retains replay protection for 90 days after processing.
			const expiredReceipts = PG.from(PlanetscaleIssueReceipts)
				.select("orgId", "eventId")
				.where(($) => [$.processedAt.lt(cutoff)])
				.orderBy(($) => [[$.processedAt, "asc"]])
				.limit(5000)
			const receipts = yield* db.run(
				PG.deleteFrom(PlanetscaleIssueReceipts)
					.where(($) => [PG.sql.cond`(${$.orgId}, ${$.eventId}) IN (${expiredReceipts})`])
					.returning("eventId"),
			)
			const aged = yield* db.run(
				PG.deleteFrom(PlanetscaleEvents)
					.where(($) => [$.occurredAt.lt(cutoff)])
					.returning("id"),
			)

			// Only orgs that could still be over the cap after the age delete are
			// probed: the OFFSET probe walks up to EVENT_MAX_ROWS_PER_ORG index
			// entries, so running it for every org would cost far more than it saves.
			const overCap = yield* db.run(
				PG.from(PlanetscaleEvents)
					.select(($) => ({ orgId: $.orgId, total: PG.count() }))
					.groupBy("orgId")
					.having(() => [PG.count().gt(EVENT_MAX_ROWS_PER_ORG)]),
			)

			yield* Effect.forEach(
				overCap,
				(org) =>
					Effect.gen(function* () {
						// Drop everything older than the Nth-newest row. The probe rides the
						// (org_id, occurred_at) index.
						const [boundary] = yield* db.run(
							PG.from(PlanetscaleEvents)
								.select("occurredAt")
								.where(($) => [$.orgId.eq(org.orgId)])
								.orderBy(["occurredAt", "desc"])
								.limit(1)
								.offset(EVENT_MAX_ROWS_PER_ORG - 1),
						)
						if (boundary === undefined) return
						yield* db.run(
							PG.deleteFrom(PlanetscaleEvents).where(($) => [
								$.orgId.eq(org.orgId),
								$.occurredAt.lt(boundary.occurredAt),
							]),
						)
					}),
				{ discard: true },
			)

			return { orgs: overCap.length, deletedByAge: aged.length, deletedReceipts: receipts.length }
		}),
	)

	yield* Effect.annotateCurrentSpan({
		"maple.planetscale.event_retention.deleted_by_age": deletedByAge,
		"maple.planetscale.event_retention.deleted_receipts": deletedReceipts,
		"maple.planetscale.event_retention.orgs_capped": orgs,
		"maple.planetscale.event_retention.outcome": "completed",
	})
	yield* Effect.logInfo("[planetscale] event retention tick complete").pipe(
		Effect.annotateLogs({ deletedByAge, orgsCapped: orgs }),
	)
}).pipe(
	// tapCause lets the cause propagate so `withSpan` marks the tick as Error.
	Effect.tapCause((cause) =>
		Effect.annotateCurrentSpan({ "maple.planetscale.event_retention.outcome": "failed" }).pipe(
			Effect.flatMap(() =>
				Effect.logError("[planetscale] event retention tick failed").pipe(
					Effect.annotateLogs({ error: String(cause) }),
				),
			),
		),
	),
	Effect.withSpan("PlanetScaleEventRetention.tick"),
)
