import { Array as Arr, Predicate, String as Str } from "effect"

import { quoteClickHouseIdentifier } from "./bookkeeping"

/**
 * A column a migration is about to add to an existing sorting key, which ClickHouse allows only in
 * the ALTER that adds the column. If an earlier apply already added it outside the key, it is
 * dropped first so that ALTER can add it again. Planned against the cluster: an absent column, or
 * one already in the key (a fresh store), plans nothing. Use it only on a column nothing has
 * written yet, so the drop loses no values, and before the migration stops merges on the table:
 * the drop is a mutation, and a stopped table never runs it.
 */
export interface DropUnkeyedColumnSpec {
	readonly kind: "drop-unkeyed-column"
	readonly table: string
	readonly column: string
}

export const isDropUnkeyedColumn = (stmt: unknown): stmt is DropUnkeyedColumnSpec =>
	Predicate.hasProperty(stmt, "kind") && stmt.kind === "drop-unkeyed-column"

const literal = Str.replace(/'/g, "''")

const target = (table: string, database: string): string =>
	database.length === 0
		? table
		: `${quoteClickHouseIdentifier(database)}.${quoteClickHouseIdentifier(table)}`

const databaseLiteral = (database: string): string =>
	database.length === 0 ? "currentDatabase()" : `'${literal(database)}'`

/** One JSONEachRow row per matching column: the column exists and is not part of the sorting key. */
export const unkeyedColumnProbeSql = (spec: DropUnkeyedColumnSpec, database: string): string =>
	`SELECT name FROM system.columns WHERE database = ${databaseLiteral(database)} AND table = '${literal(spec.table)}' AND name = '${literal(spec.column)}' AND is_in_sorting_key = 0 FORMAT JSONEachRow`

/** Waits for the mutation, so the key ALTER that follows never races a pending drop. */
export const dropUnkeyedColumnSql = (spec: DropUnkeyedColumnSpec, database: string): string =>
	`ALTER TABLE ${target(spec.table, database)} DROP COLUMN IF EXISTS ${spec.column} SETTINGS mutations_sync = 2`

/** What a dry run prints: the drop depends on the cluster, so it shows as a comment. */
export const renderDropUnkeyedColumnFull = (spec: DropUnkeyedColumnSpec): string =>
	`-- drop ${spec.table}.${spec.column} if it exists outside the sorting key (checked when applied)`

/**
 * Rows of a sorting-key column stuck at 0, which a merge or insert writes while the column has no
 * DEFAULT yet. ClickHouse refuses UPDATE on a key column, so the 0 rows move to `value` through a
 * staging copy of the table. The repair is decided when it runs (`zeroKeyRepairStatements`), after
 * merges restart, so 0s written earlier in the same apply are repaired too:
 *
 * 1. Without a ready table: drop any `<t>_retention_repair` (it only ever holds copies), then if 0
 *    rows exist, copy them into a fresh one with `value`, check it holds as many rows as the table
 *    holds 0s, and rename it to `<t>_retention_repair_ready`. A short copy fails the check.
 * 2. With a ready table (a complete copy): delete the 0 rows from the table.
 * 3. `MOVE PARTITION ... TO TABLE <t>` for each ready partition: atomic per partition, and a moved
 *    partition leaves the ready table, so none moves twice.
 * 4. Drop the ready table, refusing while it still holds a part.
 *
 * A rerun after a crash at any point converges: the delete only runs once the ready table exists.
 * Rows that already held `value` are untouched; on an aggregating table the moved copies merge with
 * them. Run it with merges running (the delete is a mutation) and nothing inserting into the table.
 */
export interface RepairZeroKeyColumnSpec {
	readonly kind: "repair-zero-key-column"
	readonly table: string
	readonly column: string
	readonly value: number
}

export const isRepairZeroKeyColumn = (stmt: unknown): stmt is RepairZeroKeyColumnSpec =>
	Predicate.hasProperty(stmt, "kind") && stmt.kind === "repair-zero-key-column"

const stagingTable = (spec: RepairZeroKeyColumnSpec): string => `${spec.table}_retention_repair`
const readyTable = (spec: RepairZeroKeyColumnSpec): string => `${spec.table}_retention_repair_ready`

/** One row when the column is in the table's sorting key, so its 0 rows can be read. */
export const keyColumnProbeSql = (spec: RepairZeroKeyColumnSpec, database: string): string =>
	`SELECT name FROM system.columns WHERE database = ${databaseLiteral(database)} AND table = '${literal(spec.table)}' AND name = '${literal(spec.column)}' AND is_in_sorting_key = 1 FORMAT JSONEachRow`

/** One row when the table holds a 0 row. */
export const zeroKeyRowsProbeSql = (spec: RepairZeroKeyColumnSpec, database: string): string =>
	`SELECT 1 AS found FROM ${target(spec.table, database)} WHERE ${spec.column} = 0 LIMIT 1 FORMAT JSONEachRow`

/** One row when the ready table, a checked complete copy, exists. */
export const readyTableProbeSql = (spec: RepairZeroKeyColumnSpec, database: string): string =>
	`SELECT name FROM system.tables WHERE database = ${databaseLiteral(database)} AND name = '${literal(readyTable(spec))}' FORMAT JSONEachRow`

/** The ready table's partitions that still hold rows; a moved partition leaves an empty part behind. */
const readyRowsSql = (spec: RepairZeroKeyColumnSpec, database: string): string =>
	`SELECT DISTINCT partition_id AS p FROM system.parts WHERE database = ${databaseLiteral(database)} AND table = '${literal(readyTable(spec))}' AND active AND rows > 0`

/** One `{"p": ...}` row per partition the ready table holds rows in; none when it does not exist. */
export const stagedPartitionsSql = (spec: RepairZeroKeyColumnSpec, database: string): string =>
	`${readyRowsSql(spec, database)} FORMAT JSONEachRow`

/** What the probes found when the repair runs. */
export interface ZeroKeyRepairState {
	readonly keyed: boolean
	readonly ready: boolean
	readonly zeros: boolean
}

/**
 * Steps 1 and 2 for the probed state; `finish` says whether the ready table's moves and drop
 * (`finishZeroKeyRepairSql`) follow. Merges stop on the copy so its row count holds still for the
 * check. The copy filters in a subquery: ClickHouse resolves a WHERE name to a SELECT alias first,
 * so beside the REPLACE the filter would read the new value and match nothing.
 */
export const zeroKeyRepairStatements = (
	spec: RepairZeroKeyColumnSpec,
	database: string,
	state: ZeroKeyRepairState,
): { readonly statements: ReadonlyArray<string>; readonly finish: boolean } => {
	const table = target(spec.table, database)
	const staging = target(stagingTable(spec), database)
	const remove = `ALTER TABLE ${table} DELETE WHERE ${spec.column} = 0 SETTINGS mutations_sync = 2`
	if (!state.keyed) return { statements: [], finish: false }
	if (state.ready) return { statements: [remove], finish: true }
	const dropStaging = `DROP TABLE IF EXISTS ${staging}`
	if (!state.zeros) return { statements: [dropStaging], finish: false }
	return {
		statements: [
			dropStaging,
			`CREATE TABLE ${staging} AS ${table}`,
			`SYSTEM STOP MERGES ${staging}`,
			`INSERT INTO ${staging} SELECT * REPLACE (toUInt16(${spec.value}) AS ${spec.column}) FROM (SELECT * FROM ${table} WHERE ${spec.column} = 0)`,
			`SELECT throwIf((SELECT count() FROM ${staging}) != (SELECT count() FROM ${table} WHERE ${spec.column} = 0), '${literal(`${stagingTable(spec)} does not hold every 0 row of ${spec.table}; rerun the apply`)}') FORMAT Null`,
			`RENAME TABLE ${staging} TO ${target(readyTable(spec), database)}`,
			remove,
		],
		finish: true,
	}
}

/** Steps 3 and 4: a move per partition the ready table holds, then its drop once no row is left. */
export const finishZeroKeyRepairSql = (
	spec: RepairZeroKeyColumnSpec,
	database: string,
	partitionIds: ReadonlyArray<string>,
): ReadonlyArray<string> => {
	const ready = target(readyTable(spec), database)
	return [
		...Arr.map(
			partitionIds,
			(partitionId) =>
				`ALTER TABLE ${ready} MOVE PARTITION ID '${literal(partitionId)}' TO TABLE ${target(spec.table, database)}`,
		),
		`SELECT throwIf((SELECT count() FROM (${readyRowsSql(spec, database)})) > 0, '${literal(`${readyTable(spec)} still holds rows not moved back to ${spec.table}; rerun the apply`)}') FORMAT Null`,
		`DROP TABLE IF EXISTS ${ready}`,
	]
}

export const renderRepairZeroKeyColumnFull = (spec: RepairZeroKeyColumnSpec): string =>
	`-- move ${spec.table} rows with ${spec.column} = 0 to ${spec.value} through ${stagingTable(spec)} if any exist (checked when applied)`
