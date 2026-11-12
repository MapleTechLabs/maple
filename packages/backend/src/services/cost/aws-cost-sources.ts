// Brings an org's AWS `cost_sources` in step with its connections: a source for every connection
// that supplies cost, off while it does not (so a grant lost for a while keeps its id, state and
// history), gone only with the connection. The sync lane runs it for every org each tick; a
// connection write runs it for its own org, so the Cost page sees the source before the next tick.
import type { MapleDb } from "@maple/db/client"
import { AwsConnections, CostSources } from "@maple/db/tables"
import type { OrgId } from "@maple/primitives"
import { CostSourceId } from "@maple/primitives"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Array as Arr, Effect, Schema } from "effect"
import { randomUUID } from "node:crypto"

/** Sources one run creates, turns on, turns off and removes, each. */
const RECONCILE_LIMIT = 200

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const COST_MODULE = encodeJson(["cost"])

type AwsConnectionColumns = PG.ColumnAccessor<typeof AwsConnections.columns>

/** The org asked for cost and the deployed role grants it. Never NULL, so it can be negated. */
const awsSuppliesCost = (
	connection: Pick<AwsConnectionColumns, "verifiedAt" | "modules" | "grantedModules">,
) =>
	PG.and(
		connection.verifiedAt.isNotNull(),
		PG.sql.cond`${connection.modules} @> ${COST_MODULE}::jsonb`,
		PG.sql.cond`coalesce(${connection.grantedModules} @> ${COST_MODULE}::jsonb, false)`,
	)

export interface AwsCostSourcesReconciled {
	readonly created: number
	readonly disabled: number
	readonly enabled: number
	readonly removed: number
}

/** Every org's sources, or only `orgId`'s. Joined by org, so a ref never crosses orgs. */
export const reconcileAwsCostSources = Effect.fnUntraced(function* (db: MapleDb, now: number, orgId?: OrgId) {
	const missing = yield* db.run(
		PG.from(AwsConnections, "c")
			.leftJoin(CostSources, "s", (connection, source) =>
				source.orgId
					.eq(connection.orgId)
					.and(source.provider.eq("aws"))
					.and(source.connectionRef.eq(connection.id)),
			)
			.select(($) => ({ id: $.id, orgId: $.orgId, accountId: $.accountId }))
			.where(($) => [
				awsSuppliesCost($),
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
					provider: "aws",
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

	/** Sources whose `enabled` is not what their connection supplies, set to it. */
	const setEnabled = (enabled: boolean) =>
		Effect.gen(function* () {
			const sources = yield* db.run(
				PG.from(CostSources, "s")
					.innerJoin(AwsConnections, "c", (source, connection) =>
						source.orgId.eq(connection.orgId).and(source.connectionRef.eq(connection.id)),
					)
					.select(($) => ({ id: $.id }))
					.where(($) => [
						$.provider.eq("aws"),
						$.enabled.eq(!enabled),
						enabled ? awsSuppliesCost($.c) : PG.not(awsSuppliesCost($.c)),
						...(orgId === undefined ? [] : [$.orgId.eq(orgId)]),
					])
					.orderBy(["id", "asc"])
					.limit(RECONCILE_LIMIT),
			)
			if (!Arr.isReadonlyArrayNonEmpty(sources)) return 0
			const changed = yield* db.run(
				PG.update(CostSources)
					.set({ enabled, updatedAt: now })
					.where(($) => [
						$.provider.eq("aws"),
						PG.inList(
							$.id,
							Arr.map(sources, (source) => source.id),
						),
					])
					.returning(($) => ({ id: $.id })),
			)
			return changed.length
		})
	const disabled = yield* setEnabled(false)
	const enabled = yield* setEnabled(true)

	const orphaned = yield* db.run(
		PG.from(CostSources, "s")
			.leftJoin(AwsConnections, "c", (source, connection) =>
				source.orgId.eq(connection.orgId).and(source.connectionRef.eq(connection.id)),
			)
			.select(($) => ({ id: $.id }))
			.where(($) => [
				$.provider.eq("aws"),
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
						$.provider.eq("aws"),
						PG.inList(
							$.id,
							Arr.map(orphaned, (source) => source.id),
						),
					])
					.returning(($) => ({ id: $.id })),
			)
		: []

	return {
		created: Arr.flatten(created).length,
		disabled,
		enabled,
		removed: removed.length,
	} satisfies AwsCostSourcesReconciled
})
