// Removes an org's GitHub `cost_sources` that can no longer be read: the installation is gone, is
// not active, or is not a GitHub organization any more. Nothing here makes a source: an org adds
// one itself on the Cost page. The sync lane runs it for every org each tick.
import type { MapleDb } from "@maple/db/client"
import { CostSources, VcsInstallations } from "@maple/db/tables"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Effect } from "effect"

/** Sources one run removes. */
const RECONCILE_LIMIT = 200

/** Joined by org, so a ref never crosses orgs. */
export const reconcileGithubCostSources = Effect.fnUntraced(function* (db: MapleDb) {
	const orphaned = PG.from(CostSources, "s")
		.leftJoin(VcsInstallations, "i", (source, installation) =>
			source.orgId.eq(installation.orgId).and(source.connectionRef.eq(installation.id)),
		)
		.select(($) => ({ id: $.id }))
		.where(($) => [
			$.provider.eq("github"),
			PG.or(
				$.i.id.isNull(),
				$.i.provider.neq("github"),
				$.i.status.neq("active"),
				$.i.accountType.neq("organization"),
			),
		])
		.orderBy(["id", "asc"])
		.limit(RECONCILE_LIMIT)
	// One statement, so an installation that turns active again between a read and a delete keeps its source.
	const removed = yield* db.run(
		PG.deleteFrom(CostSources)
			.where(($) => [$.provider.eq("github"), PG.inSubquery($.id, orphaned)])
			.returning(($) => ({ id: $.id })),
	)

	return { removed: removed.length }
})
