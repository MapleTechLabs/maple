// An org's GCP `cost_sources`, one per billing export it added. The export row is the source's
// connection: it goes when the org removes the source, and with its connector, which cascades.
import type { MapleDb } from "@maple/db/client"
import { CostSources, GcpCostExports } from "@maple/db/tables"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Array as Arr, Effect } from "effect"

/** Sources one run removes. */
const RECONCILE_LIMIT = 200

/**
 * Removes the sources whose export is gone, in every org. The sync lane runs it each tick: a
 * connector deleted with its integration source takes its exports along, which no cost service
 * sees. Joined by org, so a ref never crosses orgs.
 */
export const reconcileGcpCostSources = Effect.fnUntraced(function* (db: MapleDb) {
	const orphaned = yield* db.run(
		PG.from(CostSources, "s")
			.leftJoin(GcpCostExports, "e", (source, exp) =>
				source.orgId.eq(exp.orgId).and(source.connectionRef.eq(exp.id)),
			)
			.select(($) => ({ id: $.id }))
			.where(($) => [$.provider.eq("gcp"), $.e.id.isNull()])
			.orderBy(["id", "asc"])
			.limit(RECONCILE_LIMIT),
	)
	const removed = Arr.isReadonlyArrayNonEmpty(orphaned)
		? yield* db.run(
				PG.deleteFrom(CostSources)
					.where(($) => [
						$.provider.eq("gcp"),
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
