import * as Orm from "@maple-dev/effect-orm/database"
import { OrgId, type OrgId as OrgIdType } from "@maple/domain"
import type { MapleOrm, MapleOrmError } from "@maple/db/client"
import { Effect, Schema } from "effect"

/** An effect-orm table with an `orgId` column, the only shape this walks. */
export interface OrgScopedTable {
	readonly name: string
	readonly columns: { readonly orgId: { readonly sqlName?: string } }
}

const OrgIdRow = Schema.Struct({ org_id: OrgId })

/**
 * `SELECT DISTINCT org_id FROM <table>` via a loose index scan.
 *
 * Postgres has no skip scan, so a plain `SELECT DISTINCT` reads every row — or
 * every entry of a covering index — just to return a handful of values. In
 * production that cost 270k rows per call on `error_issues` and 160k on
 * `error_issue_states`, together ~36% of all database CPU and 620M rows read a
 * day, and it grew with table size rather than with workload.
 *
 * The recursive CTE below walks the btree one value at a time: an index descent
 * per distinct org instead of a full scan. It requires an index whose LEADING
 * column is the table's `orgId` column. Every table this is used on has one,
 * either the primary key or an `(org_id, ...)` composite.
 *
 * Pattern: https://wiki.postgresql.org/wiki/Loose_indexscan
 */
export const selectDistinctOrgIds = (
	orm: MapleOrm,
	table: OrgScopedTable,
): Effect.Effect<ReadonlyArray<OrgIdType>, MapleOrmError> => {
	const from = Orm.sql.identifier(table.name)
	const column = Orm.sql.identifier(table.columns.orgId.sqlName ?? "orgId")
	return Effect.map(
		orm.query(
			Orm.sql`
		with recursive t as (
			(
				select ${column} as org_id
				from ${from}
				where ${column} is not null
				order by ${column}
				limit 1
			)
			union all
			select (
				select ${column}
				from ${from}
				where ${column} > t.org_id
				order by ${column}
				limit 1
			)
			from t
			where t.org_id is not null
		)
		select org_id from t where org_id is not null
	`,
			OrgIdRow,
		),
		(rows) => rows.map((row) => row.org_id),
	)
}
