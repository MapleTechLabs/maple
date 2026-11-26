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
 * DEFAULT yet. ClickHouse refuses UPDATE on a key column, so the 0 rows move to `value` through a
 * staging copy of the table, and every statement is safe to run again after any failure:
 *
 * 1. `CREATE TABLE IF NOT EXISTS <t>_retention_repair AS <t>`.
 * 2. Copy the 0 rows into it with `value`, only while it is empty: a rerun after the copy copies
 *    nothing again, so the staged rows are the replacement record until they move.
 * 3. Delete the 0 rows from the table.
 * 4. `MOVE PARTITION ... TO TABLE <t>` for each staged partition: atomic per partition, and a moved
 *    partition leaves the staging table, so none moves twice; a missing one is a no-op.
 * 5. Drop the staging table.
 *
 * Rows that already held `value` are untouched; on an aggregating table the moved copies merge with
 * them. Planned against the cluster: only when the column is in the key and holds a 0, or a staging
 * table is left from an earlier run. Run it with merges running (the delete is a mutation) and with
 * nothing inserting into the table.
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

/** One row when the column is in the table's sorting key, so its 0 rows can be read. */
export const keyColumnProbeSql = (spec: RepairZeroKeyColumnSpec, database: string): string =>
	`SELECT name FROM system.columns WHERE database = ${databaseLiteral(database)} AND table = '${literal(spec.table)}' AND name = '${literal(spec.column)}' AND is_in_sorting_key = 1 FORMAT JSONEachRow`

/** One `{"p": ...}` row per partition of the table holding a 0 row. */
export const zeroKeyPartitionsSql = (spec: RepairZeroKeyColumnSpec, database: string): string =>
	`SELECT DISTINCT _partition_id AS p FROM ${target(spec.table, database)} WHERE ${spec.column} = 0 FORMAT JSONEachRow`

/** One `{"p": ...}` row per partition the staging table holds; none when it does not exist. */
export const stagedPartitionsSql = (spec: RepairZeroKeyColumnSpec, database: string): string =>
	`SELECT DISTINCT partition_id AS p FROM system.parts WHERE database = ${databaseLiteral(database)} AND table = '${literal(stagingTable(spec))}' AND active FORMAT JSONEachRow`

/** One row when the staging table exists. */
export const stagingTableProbeSql = (spec: RepairZeroKeyColumnSpec, database: string): string =>
	`SELECT name FROM system.tables WHERE database = ${databaseLiteral(database)} AND name = '${literal(stagingTable(spec))}' FORMAT JSONEachRow`

/**
 * Steps 1 to 3. The copy filters in a subquery: ClickHouse resolves a WHERE name to a SELECT alias
 * first, so beside the REPLACE the filter would read the new value and match nothing.
 */
export const stageZeroKeyRowsSql = (
	spec: RepairZeroKeyColumnSpec,
	database: string,
): ReadonlyArray<string> => {
	const table = target(spec.table, database)
	const staging = target(stagingTable(spec), database)
	return [
		`CREATE TABLE IF NOT EXISTS ${staging} AS ${table}`,
		`INSERT INTO ${staging} SELECT * REPLACE (toUInt16(${spec.value}) AS ${spec.column}) FROM (SELECT * FROM ${table} WHERE ${spec.column} = 0) WHERE (SELECT count() FROM ${staging}) = 0`,
		`ALTER TABLE ${table} DELETE WHERE ${spec.column} = 0 SETTINGS mutations_sync = 2`,
	]
}

/** Step 4, for one partition id. */
export const moveStagedPartitionSql = (
	spec: RepairZeroKeyColumnSpec,
	database: string,
	partitionId: string,
): string =>
	`ALTER TABLE ${target(stagingTable(spec), database)} MOVE PARTITION ID '${literal(partitionId)}' TO TABLE ${target(spec.table, database)}`

/** Step 5. */
export const dropStagingTableSql = (spec: RepairZeroKeyColumnSpec, database: string): string =>
	`DROP TABLE IF EXISTS ${target(stagingTable(spec), database)}`

export const renderRepairZeroKeyColumnFull = (spec: RepairZeroKeyColumnSpec): string =>
	`-- move ${spec.table} rows with ${spec.column} = 0 to ${spec.value} through ${stagingTable(spec)} if any exist (checked when applied)`
