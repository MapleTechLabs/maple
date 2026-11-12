// An org's Vercel `cost_sources`. The connection does not make the source: the org adds its team
// on the Cost page, and that row is the opt-in. It goes when the org removes it, with the
// connection, and when the connection moves to another team (whose spend would overwrite its days).
import type { MapleDb } from "@maple/db/client"
import { CostSources, VercelConnections } from "@maple/db/tables"
import type { OrgId } from "@maple/primitives"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Array as Arr, Effect } from "effect"

/** Sources one run removes. */
const RECONCILE_LIMIT = 200

/** Deletes the org's Vercel sources (it has one connection, so one source at most) and answers how many. */
export const removeVercelCostSources = (db: MapleDb, orgId: OrgId) =>
	db
		.run(
			PG.deleteFrom(CostSources)
				.where(($) => [$.orgId.eq(orgId), $.provider.eq("vercel")])
				.returning(($) => ({ id: $.id })),
		)
		.pipe(Effect.map((rows) => rows.length))

/**
 * A new token was saved for the team the source reads. The source is due at the next tick (no
 * hold, and no last sync to wait a day from), a pull in flight on the old token loses its claim,
 * and the account follows the team's slug, which the connection may just have rewritten.
 */
export const releaseVercelCostSources = (db: MapleDb, orgId: OrgId, teamSlug: string, now: number) =>
	db.run(
		PG.update(CostSources)
			.set({
				accountId: teamSlug,
				lastSyncedAt: null,
				leaseUntil: null,
				lastError: null,
				lastErrorReason: null,
				nextAttemptAt: null,
				consecutiveFailures: 0,
				updatedAt: now,
			})
			.where(($) => [$.orgId.eq(orgId), $.provider.eq("vercel")]),
	)

/**
 * Removes the sources whose connection is gone, in every org. The sync lane runs it each tick: a
 * connection can also vanish with its integration source, which no service of this provider
 * sees. Joined by org, so a ref never crosses orgs.
 */
export const reconcileVercelCostSources = Effect.fnUntraced(function* (db: MapleDb) {
	const orphaned = yield* db.run(
		PG.from(CostSources, "s")
			.leftJoin(VercelConnections, "c", (source, connection) =>
				source.orgId.eq(connection.orgId).and(source.connectionRef.eq(connection.id)),
			)
			.select(($) => ({ id: $.id }))
			.where(($) => [$.provider.eq("vercel"), $.c.id.isNull()])
			.orderBy(["id", "asc"])
			.limit(RECONCILE_LIMIT),
	)
	const removed = Arr.isReadonlyArrayNonEmpty(orphaned)
		? yield* db.run(
				PG.deleteFrom(CostSources)
					.where(($) => [
						$.provider.eq("vercel"),
						PG.inList(
							$.id,
							Arr.map(orphaned, (source) => source.id),
						),
					])
					.returning(($) => ({ id: $.id })),
			)
		: []
	return { removed: removed.length }
})
