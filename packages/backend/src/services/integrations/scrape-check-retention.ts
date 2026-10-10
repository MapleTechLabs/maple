import type { ScrapeTargetId } from "@maple/domain"
import * as PG from "@maple-dev/effect-orm/postgres"
import { ScrapeTargetChecks, ScrapeTargets } from "@maple/db/tables"
import { Clock, Effect } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"

/**
 * Check-history retention for `scrape_target_checks`.
 *
 * This used to run inline on `POST /api/internal/scrape-results`, where it cost
 * 1 + 2N `Database.execute` calls per report — ~39k Postgres round-trips a day
 * and 29% of that route's latency — for maintenance no caller is waiting on. It
 * now runs from the API worker's hourly cron.
 *
 * It lives outside `ScrapeTargetsService` so the cron's layer graph needs only
 * `Database`, not the PlanetScale discovery/OAuth services that the request-path
 * service depends on.
 */

/** Retention: 24h sliding window… */
const CHECK_RETENTION_MS = 24 * 60 * 60 * 1000
/** …with a per-target row cap as backstop against very short intervals. */
const CHECK_MAX_ROWS_PER_TARGET = 10_000

/** What retention needs to know about a target to prune its check history. */
export interface RetentionTarget {
	readonly id: ScrapeTargetId
	readonly targetType: string
	readonly scrapeIntervalSeconds: number
}

/**
 * Can this target still hold more than the row cap after the 24h delete?
 *
 * A plain target writes exactly one check row per interval, so 24h of history
 * is `86400 / interval` rows — under the 10k cap for anything slower than
 * ~8.6s, which is every real configuration. `planetscale` targets fan out to
 * one row per discovered branch per interval, so their row count is not
 * derivable from the interval alone and they always get probed.
 *
 * This gate is what makes the cap affordable: the probe below has to walk
 * `CHECK_MAX_ROWS_PER_TARGET` index entries to find the Nth-newest row, which
 * across ~740 targets every hour read 136M rows a day — 6.5% of all database
 * time — to return a boundary for a handful of them.
 */
export const canExceedRowCap = (target: RetentionTarget): boolean => {
	if (target.targetType === "planetscale") return true
	if (target.scrapeIntervalSeconds <= 0) return true
	return CHECK_RETENTION_MS / 1000 / target.scrapeIntervalSeconds >= CHECK_MAX_ROWS_PER_TARGET
}

/**
 * Apply retention to the given targets.
 *
 * Every statement runs inside ONE `execute`: under `DatabasePgLive` each call
 * dials and tears down its own postgres.js client, so the handshake count is
 * what costs, not the statement count.
 */
export const pruneChecksForTargets = Effect.fn("ScrapeCheckRetention.pruneForTargets")(function* (
	targets: ReadonlyArray<RetentionTarget>,
) {
	const [firstId, ...restIds] = targets.map((target) => target.id)
	if (firstId === undefined) return
	const now = yield* Clock.currentTimeMillis
	const cutoff = now - CHECK_RETENTION_MS
	const capCandidates = targets.filter(canExceedRowCap)
	const database = yield* Database

	yield* database.execute((db) =>
		Effect.gen(function* () {
			yield* db.run(
				PG.deleteFrom(ScrapeTargetChecks).where(($) => [
					$.targetId.in_(firstId, ...restIds),
					$.checkedAt.lt(cutoff),
				]),
			)

			// Cap backstop for misconfigured/very short intervals: drop everything
			// older than the Nth-newest row per target. The OFFSET probe rides the
			// (target_id, checked_at) index, so it stays cheaper than a window
			// function over the target's full history.
			yield* Effect.forEach(
				capCandidates,
				(target) =>
					Effect.gen(function* () {
						const [boundary] = yield* db.run(
							PG.from(ScrapeTargetChecks)
								.select("checkedAt")
								.where(($) => [$.targetId.eq(target.id)])
								.orderBy(["checkedAt", "desc"])
								.limit(1)
								.offset(CHECK_MAX_ROWS_PER_TARGET - 1),
						)
						if (boundary === undefined) return
						yield* db.run(
							PG.deleteFrom(ScrapeTargetChecks).where(($) => [
								$.targetId.eq(target.id),
								$.checkedAt.lt(boundary.checkedAt),
							]),
						)
					}),
				{ discard: true },
			)
		}),
	)
	yield* Effect.annotateCurrentSpan({
		"maple.scrape.retention.targets": targets.length,
		"maple.scrape.retention.cap_probed": capCandidates.length,
	})
})

/** The cron program: apply retention across every scrape target. */
export const runScrapeCheckRetention = Effect.gen(function* () {
	const database = yield* Database
	const rows = yield* database.execute((db) =>
		db.run(PG.from(ScrapeTargets).select("id", "targetType", "scrapeIntervalSeconds")),
	)
	yield* pruneChecksForTargets(rows)
	yield* Effect.annotateCurrentSpan({
		"maple.scrape.retention.targets": rows.length,
		"maple.scrape.retention.outcome": "completed",
	})
	yield* Effect.logInfo("[scrape] check retention tick complete").pipe(
		Effect.annotateLogs({ targets: rows.length }),
	)
}).pipe(
	// tapCause lets the cause propagate so `withSpan` marks the tick as Error.
	Effect.tapCause((cause) =>
		Effect.annotateCurrentSpan({ "maple.scrape.retention.outcome": "failed" }).pipe(
			Effect.flatMap(() =>
				Effect.logError("[scrape] check retention tick failed").pipe(
					Effect.annotateLogs({ error: String(cause) }),
				),
			),
		),
	),
	Effect.withSpan("ScrapeCheckRetention.tick"),
)
