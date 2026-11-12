// Brings `cost_sources` in step with `cost_connections` for one provider read with a pasted
// credential: a source while the credential exists, named after its account, gone with it. The
// sync lane runs it for every org each tick, a credential write for its own org at once.
import type { MapleDb } from "@maple/db/client"
import { CostConnections, CostSources } from "@maple/db/tables"
import type { CostProvider } from "@maple/domain/cost"
import type { OrgId } from "@maple/primitives"
import { CostSourceId } from "@maple/primitives"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Array as Arr, Effect } from "effect"
import { randomUUID } from "node:crypto"

/** The providers whose credential lives in `cost_connections`: one added here needs no table, slot or reconcile of its own. */
export const COST_CONNECTION_PROVIDERS = [
	"cloudflare",
	"planetscale",
] as const satisfies ReadonlyArray<CostProvider>
export type CostConnectionProvider = (typeof COST_CONNECTION_PROVIDERS)[number]

/** Sources one run creates and removes, each. */
const RECONCILE_LIMIT = 200

/** Every org's sources of `provider`, or only `orgId`'s. Joined by org, so a ref never crosses orgs. */
export const reconcileCostConnectionSources = Effect.fnUntraced(function* (
	db: MapleDb,
	now: number,
	provider: CostConnectionProvider,
	orgId?: OrgId,
) {
	const missing = yield* db.run(
		PG.from(CostConnections, "c")
			.leftJoin(CostSources, "s", (connection, source) =>
				source.orgId
					.eq(connection.orgId)
					.and(source.provider.eq(provider))
					.and(source.connectionRef.eq(connection.id)),
			)
			.select(($) => ({ id: $.id, orgId: $.orgId, accountId: $.accountId }))
			.where(($) => [
				$.provider.eq(provider),
				$.s.id.isNull(),
				...(orgId === undefined ? [] : [$.orgId.eq(orgId)]),
			])
			.orderBy(["id", "asc"])
			.limit(RECONCILE_LIMIT),
	)
	const created = yield* Effect.forEach(missing, (connection) =>
		db.run(
			PG.insertInto(CostSources)
				.values({
					id: CostSourceId.make(randomUUID()),
					orgId: connection.orgId,
					provider,
					connectionRef: connection.id,
					accountId: connection.accountId,
					createdAt: now,
					updatedAt: now,
				})
				// Another run made it first.
				.onConflictDoNothing()
				.returning(($) => ({ id: $.id })),
		),
	)

	const orphaned = yield* db.run(
		PG.from(CostSources, "s")
			.leftJoin(CostConnections, "c", (source, connection) =>
				source.orgId
					.eq(connection.orgId)
					.and(source.connectionRef.eq(connection.id))
					.and(connection.provider.eq(provider)),
			)
			.select(($) => ({ id: $.id }))
			.where(($) => [
				$.provider.eq(provider),
				$.c.id.isNull(),
				...(orgId === undefined ? [] : [$.orgId.eq(orgId)]),
			])
			.orderBy(["id", "asc"])
			.limit(RECONCILE_LIMIT),
	)
	const removed = Arr.isReadonlyArrayNonEmpty(orphaned)
		? yield* db.run(
				PG.deleteFrom(CostSources)
					.where(($) => [
						$.provider.eq(provider),
						PG.inList(
							$.id,
							Arr.map(orphaned, (source) => source.id),
						),
					])
					.returning(($) => ({ id: $.id })),
			)
		: []

	return { created: Arr.flatten(created).length, removed: removed.length }
})
