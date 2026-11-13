// Brings an org's OpenRouter `cost_sources` in step with its saved management key: a source while
// the key exists, named after the key's OpenRouter account, gone with it. The sync lane runs it for every org each tick; a
// key write runs it for its own org, so the Cost page sees the source before the next tick.
import type { MapleDb } from "@maple/db/client"
import { CostSources, OpenRouterCostConnections } from "@maple/db/tables"
import type { OrgId } from "@maple/primitives"
import { CostSourceId } from "@maple/primitives"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Array as Arr, Effect } from "effect"
import { randomUUID } from "node:crypto"

/** Sources one run creates and removes, each. */
const RECONCILE_LIMIT = 200

/** Every org's sources, or only `orgId`'s. Joined by org, so a ref never crosses orgs. */
export const reconcileOpenRouterCostSources = Effect.fnUntraced(function* (
	db: MapleDb,
	now: number,
	orgId?: OrgId,
) {
	const missing = yield* db.run(
		PG.from(OpenRouterCostConnections, "c")
			.leftJoin(CostSources, "s", (connection, source) =>
				source.orgId
					.eq(connection.orgId)
					.and(source.provider.eq("openrouter"))
					.and(source.connectionRef.eq(connection.id)),
			)
			.select(($) => ({ id: $.id, orgId: $.orgId, accountId: $.accountId }))
			.where(($) => [$.s.id.isNull(), ...(orgId === undefined ? [] : [$.orgId.eq(orgId)])])
			.orderBy(["id", "asc"])
			.limit(RECONCILE_LIMIT),
	)
	const created = yield* Effect.forEach(missing, (connection) =>
		db.run(
			PG.insertInto(CostSources)
				.values({
					id: CostSourceId.make(randomUUID()),
					orgId: connection.orgId,
					provider: "openrouter",
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
			.leftJoin(OpenRouterCostConnections, "c", (source, connection) =>
				source.orgId.eq(connection.orgId).and(source.connectionRef.eq(connection.id)),
			)
			.select(($) => ({ id: $.id }))
			.where(($) => [
				$.provider.eq("openrouter"),
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
						$.provider.eq("openrouter"),
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
