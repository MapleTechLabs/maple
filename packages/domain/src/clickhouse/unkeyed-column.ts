import { Predicate, String as Str } from "effect"

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
	database.length === 0 ? table : `\`${database}\`.\`${table}\``

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
 * DEFAULT yet. ClickHouse refuses UPDATE on a key column, so each 0 row is copied with `value` and
 * the 0s are deleted; on an aggregating table the copies merge with their siblings. Planned against
 * the cluster: only when the column is in the key and holds a 0. Run it with merges running (the
 * delete is a mutation) and with nothing inserting into the table.
 */
export interface RepairZeroKeyColumnSpec {
	readonly kind: "repair-zero-key-column"
	readonly table: string
	readonly column: string
	readonly value: number
}

export const isRepairZeroKeyColumn = (stmt: unknown): stmt is RepairZeroKeyColumnSpec =>
	Predicate.hasProperty(stmt, "kind") && stmt.kind === "repair-zero-key-column"

/** One row when the column is in the table's sorting key, so the 0 count can be read. */
export const keyColumnProbeSql = (spec: RepairZeroKeyColumnSpec, database: string): string =>
	`SELECT name FROM system.columns WHERE database = ${databaseLiteral(database)} AND table = '${literal(spec.table)}' AND name = '${literal(spec.column)}' AND is_in_sorting_key = 1 FORMAT JSONEachRow`

export const zeroKeyRowsProbeSql = (spec: RepairZeroKeyColumnSpec, database: string): string =>
	`SELECT toString(count()) AS zeros FROM ${target(spec.table, database)} WHERE ${spec.column} = 0 FORMAT JSONEachRow`

/**
 * The copy, then the delete; the delete waits so the view recreated next never races it. The copy
 * filters in a subquery: ClickHouse resolves a WHERE name to a SELECT alias first, so beside the
 * REPLACE the filter would read the new value and match nothing.
 */
export const repairZeroKeyColumnSql = (
	spec: RepairZeroKeyColumnSpec,
	database: string,
): readonly [copy: string, remove: string] => [
	`INSERT INTO ${target(spec.table, database)} SELECT * REPLACE (toUInt16(${spec.value}) AS ${spec.column}) FROM (SELECT * FROM ${target(spec.table, database)} WHERE ${spec.column} = 0)`,
	`ALTER TABLE ${target(spec.table, database)} DELETE WHERE ${spec.column} = 0 SETTINGS mutations_sync = 2`,
]

export const renderRepairZeroKeyColumnFull = (spec: RepairZeroKeyColumnSpec): string =>
	`-- move ${spec.table} rows with ${spec.column} = 0 to ${spec.value} if any exist (checked when applied)`
