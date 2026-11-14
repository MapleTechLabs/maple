// An org's PlanetScale `cost_sources`. The connection does not make the source: the org adds its
// organization on the Cost page, and that row is the opt-in. It goes when the org removes it, with
// the connection, and when the connection is bound to another organization (whose invoices would
// overwrite its days).
import type { MapleDb } from "@maple/db/client"
import { CostSources, PlanetscaleConnections } from "@maple/db/tables"
import type { OrgId } from "@maple/primitives"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Array as Arr, Effect } from "effect"

/** Sources one run removes. */
const RECONCILE_LIMIT = 200

/** Deletes the org's PlanetScale sources (it has one connection, so one source at most) and answers how many. */
export const removePlanetScaleCostSources = (db: MapleDb, orgId: OrgId) =>
	db
		.run(
			PG.deleteFrom(CostSources)
				.where(($) => [$.orgId.eq(orgId), $.provider.eq("planetscale")])
				.returning(($) => ({ id: $.id })),
		)
		.pipe(Effect.map((rows) => rows.length))

/** Deletes the org's PlanetScale sources that read another organization than `organization`. */
export const removePlanetScaleCostSourcesOfOthers = (db: MapleDb, orgId: OrgId, organization: string) =>
	db.run(
		PG.deleteFrom(CostSources).where(($) => [
			$.orgId.eq(orgId),
			$.provider.eq("planetscale"),
			$.accountId.neq(organization),
		]),
	)

/**
 * The org authorized PlanetScale again. Its source, if it has one, reads the same organization
 * until the connection is bound to another, which removes it. The source is due at
 * the next tick (no hold, and no last sync to wait a day from), and a pull in flight on the old
 * grant loses its claim: a grant that now carries the invoice scope is read at once. Written with
 * the grant, since a grant that sees several organizations is not bound again.
 */
export const releasePlanetScaleCostSources = (db: MapleDb, orgId: OrgId, now: number) =>
	db.run(
		PG.update(CostSources)
			.set({
				lastSyncedAt: null,
				leaseUntil: null,
				lastError: null,
				lastErrorReason: null,
				nextAttemptAt: null,
				consecutiveFailures: 0,
				updatedAt: now,
			})
			.where(($) => [$.orgId.eq(orgId), $.provider.eq("planetscale")]),
	)

/**
 * Removes the sources whose connection is gone or reads another organization by now, in every
 * org. The sync lane runs it each tick: a connection can also vanish with its integration source,
 * which no service of this provider sees. Joined by org, so a ref never crosses orgs.
 */
export const reconcilePlanetScaleCostSources = Effect.fnUntraced(function* (db: MapleDb) {
	const orphaned = yield* db.run(
		PG.from(CostSources, "s")
			.leftJoin(PlanetscaleConnections, "c", (source, connection) =>
				source.orgId
					.eq(connection.orgId)
					.and(source.connectionRef.eq(connection.id))
					.and(source.accountId.eq(connection.psOrganization)),
			)
			.select(($) => ({ id: $.id }))
			.where(($) => [$.provider.eq("planetscale"), $.c.id.isNull()])
			.orderBy(["id", "asc"])
			.limit(RECONCILE_LIMIT),
	)
	const removed = Arr.isReadonlyArrayNonEmpty(orphaned)
		? yield* db.run(
				PG.deleteFrom(CostSources)
					.where(($) => [
						$.provider.eq("planetscale"),
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
