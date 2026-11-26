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

/** One JSONEachRow row per matching column: the column exists and is not part of the sorting key. */
export const unkeyedColumnProbeSql = (spec: DropUnkeyedColumnSpec, database: string): string =>
	`SELECT name FROM system.columns WHERE database = ${database.length === 0 ? "currentDatabase()" : `'${literal(database)}'`} AND table = '${literal(spec.table)}' AND name = '${literal(spec.column)}' AND is_in_sorting_key = 0 FORMAT JSONEachRow`

/** Waits for the mutation, so the key ALTER that follows never races a pending drop. */
export const dropUnkeyedColumnSql = (spec: DropUnkeyedColumnSpec, database: string): string =>
	`ALTER TABLE ${database.length === 0 ? spec.table : `\`${database}\`.\`${spec.table}\``} DROP COLUMN IF EXISTS ${spec.column} SETTINGS mutations_sync = 2`

/** What a dry run prints: the drop depends on the cluster, so it shows as a comment. */
export const renderDropUnkeyedColumnFull = (spec: DropUnkeyedColumnSpec): string =>
	`-- drop ${spec.table}.${spec.column} if it exists outside the sorting key (checked when applied)`
