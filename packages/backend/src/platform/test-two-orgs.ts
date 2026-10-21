import { randomUUID } from "node:crypto"
import { OrgId, UserId } from "@maple/domain/http"
import { Effect, Schema } from "effect"
import type { TestDb } from "./test-pglite"

/**
 * Two tenants for cross-org tests. Every isolation test seeds the same kinds of
 * rows for both, acts as one, and asserts the other's rows are untouched: the
 * predicate that scopes a query to its org is only proven by a second org.
 */
export const ORG_A = Schema.decodeUnknownSync(OrgId)("org_tenant_a")
export const ORG_B = Schema.decodeUnknownSync(OrgId)("org_tenant_b")
export const USER_A = Schema.decodeUnknownSync(UserId)("user_tenant_a")
export const USER_B = Schema.decodeUnknownSync(UserId)("user_tenant_b")

const ColumnInfo = Schema.Struct({
	column_name: Schema.String,
	udt_name: Schema.String,
	is_nullable: Schema.Literals(["YES", "NO"]),
	column_default: Schema.NullOr(Schema.String),
	is_identity: Schema.Literals(["YES", "NO"]),
	is_generated: Schema.Literals(["ALWAYS", "NEVER"]),
})
type ColumnInfo = typeof ColumnInfo.Type

const CountRow = Schema.Struct({ n: Schema.Number })

/** Raw SQL against the test instance; `rows` decodes what comes back, so nothing is assumed. */
const query = <S extends Schema.Top>(db: TestDb, rows: S, sql: string, params: ReadonlyArray<unknown> = []) =>
	Effect.promise(() => db.pglite.query(sql, [...params])).pipe(
		Effect.flatMap((result) => Schema.decodeUnknownEffect(Schema.Array(rows))(result.rows)),
	)

const NoRows = Schema.Struct({})

type SeedValue = string | number | boolean | Uint8Array

/** A value for a required column, unique per (table, column, org) so keys never collide. */
const valueFor = (column: ColumnInfo, tag: string): SeedValue => {
	const type = column.udt_name
	if (type.startsWith("_")) return "{}"
	if (type === "bool") return false
	if (type === "jsonb" || type === "json") return "{}"
	if (type === "uuid") return randomUUID()
	if (type === "bytea") return new Uint8Array([0])
	if (type === "timestamptz" || type === "timestamp" || type === "date") return new Date(0).toISOString()
	if (["int2", "int4", "int8", "numeric", "float4", "float8"].includes(type)) return 1
	return `${tag}:${column.column_name}:${randomUUID()}`
}

/**
 * Insert one row into `tableName` owned by `orgId` through `orgColumn`, filling
 * every other required column from the live catalog. Foreign keys are switched
 * off for the insert (`session_replication_role = replica`), so a child table is
 * seedable without its parent; the values are unique, so nothing cascades into it.
 */
export const seedOrgRow = (db: TestDb, tableName: string, orgColumn: string, orgId: OrgId) =>
	Effect.gen(function* () {
		const columns = yield* query(
			db,
			ColumnInfo,
			`SELECT column_name, udt_name, is_nullable, column_default, is_identity, is_generated
			 FROM information_schema.columns
			 WHERE table_schema = 'public' AND table_name = $1
			 ORDER BY ordinal_position`,
			[tableName],
		)
		const required = columns.filter(
			(column) =>
				column.column_name === orgColumn ||
				(column.is_nullable === "NO" &&
					column.column_default === null &&
					column.is_identity === "NO" &&
					column.is_generated === "NEVER"),
		)
		const values = required.map((column): SeedValue =>
			column.column_name === orgColumn ? orgId : valueFor(column, `${tableName}:${orgId}`),
		)
		const names = required.map((column) => `"${column.column_name}"`).join(", ")
		const placeholders = required.map((_, index) => `$${index + 1}`).join(", ")
		yield* Effect.acquireUseRelease(
			query(db, NoRows, "SET session_replication_role = replica"),
			() => query(db, NoRows, `INSERT INTO "${tableName}" (${names}) VALUES (${placeholders})`, values),
			() => query(db, NoRows, "RESET session_replication_role"),
		)
	})

/** How many rows of `tableName` belong to `orgId` through `orgColumn`. */
export const countOrgRows = (db: TestDb, tableName: string, orgColumn: string, orgId: OrgId) =>
	query(db, CountRow, `SELECT count(*)::int AS n FROM "${tableName}" WHERE "${orgColumn}" = $1`, [
		orgId,
	]).pipe(Effect.map((rows) => rows[0]?.n ?? 0))
