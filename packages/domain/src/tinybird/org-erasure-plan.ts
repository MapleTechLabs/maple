import { isDatasourceDefinition } from "@maple-dev/effect-orm/tinybird"
import { Array as Arr, Option, Order, Record as Rec, Schema } from "effect"
import * as Datasources from "./datasources"
import * as Materializations from "./materializations"

/**
 * Which warehouse datasources a deleted organization's rows are erased from, and in what order.
 * Deletes do not cascade to materialized views, so every OrgId datasource is its own target, and
 * a rollup goes before what feeds it: a purge that stops halfway leaves the raw rows to retry from.
 */

/** Kept on purpose: the org-wide record of who did what, whose retention is its own decision. */
export const RETAINED_ON_ORG_ERASURE: ReadonlySet<string> = new Set([Datasources.auditLog._name])

/** Filled from `traces` by the scheduled service-map rollup job, not by a view, so no lineage names them. */
const JOB_FED: ReadonlyArray<readonly [string, string]> = [
	[Datasources.serviceMapEdgesHourly._name, Datasources.traces._name],
	[Datasources.serviceAddressResolutionsHourly._name, Datasources.traces._name],
]

const decodeLineage = Schema.decodeUnknownOption(
	Schema.TaggedStruct("MaterializedView", {
		ddl: Schema.Struct({ to: Schema.String, sources: Schema.Array(Schema.String) }),
	}),
)

/** Every datasource a view or job fills, with what it is filled from. */
const feeds: ReadonlyArray<readonly [string, string]> = [
	...Arr.flatMap(Rec.values(Materializations), (value) =>
		Option.match(decodeLineage(value), {
			onNone: () => [],
			onSome: ({ ddl }) => Arr.map(ddl.sources, (source) => [ddl.to, source] as const),
		}),
	),
	...JOB_FED,
]

/** 0 for a raw table, else one more than the deepest table it is filled from. */
const depthOf = (name: string, seen: ReadonlySet<string> = new Set()): number => {
	if (seen.has(name)) return 0
	const sources = Arr.flatMap(feeds, ([to, source]) => (to === name ? [source] : []))
	const next = new Set([...seen, name])
	return Arr.reduce(sources, 0, (deepest, source) => Math.max(deepest, depthOf(source, next) + 1))
}

export interface WarehouseErasureTarget {
	readonly datasource: string
	/** Deleted while no target of a higher rank remains for the org. */
	readonly rank: number
}

/** Every OrgId datasource but the retained ones, deepest rollup first. */
export const WAREHOUSE_ERASURE_TARGETS: ReadonlyArray<WarehouseErasureTarget> = Arr.sort(
	Arr.flatMap(Rec.values(Datasources), (value): ReadonlyArray<WarehouseErasureTarget> =>
		isDatasourceDefinition(value) &&
		value.options.tenantColumn === "OrgId" &&
		!RETAINED_ON_ORG_ERASURE.has(value._name)
			? [{ datasource: value._name, rank: depthOf(value._name) }]
			: [],
	),
	Order.combine(
		Order.mapInput(Order.flip(Order.Number), (target: WarehouseErasureTarget) => target.rank),
		Order.mapInput(Order.String, (target: WarehouseErasureTarget) => target.datasource),
	),
)

const RANKS: ReadonlyMap<string, number> = new Map(
	Arr.map(WAREHOUSE_ERASURE_TARGETS, (target) => [target.datasource, target.rank] as const),
)

/** A queued target's rank; one no longer in the catalog (a dropped datasource) goes last. */
export const warehouseErasureRank = (datasource: string): number => RANKS.get(datasource) ?? 0
