// SAFETY-FILE: snapshot JSON is drizzle-kit's own output, read by the lib's importer.
// The effect-orm table definitions must describe exactly the database the
// drizzle migrations build. Two checks: the definitions against drizzle-kit's
// head snapshot, entity by entity, and a live comparison of the catalog
// Postgres deparses for a database migrated by the bundled migrations and one
// created from the definitions alone.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { PGlite } from "@electric-sql/pglite"
import * as S from "@maple-dev/effect-orm/schema"
import { Effect } from "effect"
import type { PgSchemaTable } from "@maple-dev/effect-orm/postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { listBundledMigrations, runMigrations } from "../migrate"

const headSnapshot = () => {
	const head = listBundledMigrations().at(-1)!
	return S.fromDrizzleSnapshot(JSON.parse(readFileSync(join(head.sqlPath, "..", "snapshot.json"), "utf8")))
}

const tableOf = (entity: S.PgSchemaEntity): string => (entity.kind === "table" ? entity.name : entity.table)

/** Every column, constraint and index of `tables`, as Postgres itself prints them. */
const catalog = async (db: PGlite, tables: ReadonlyArray<string>) => {
	const columns = await db.query<Record<string, unknown>>(
		`SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default, is_identity, identity_generation
		 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1) ORDER BY table_name, column_name`,
		[tables],
	)
	const constraints = await db.query<Record<string, unknown>>(
		`SELECT c.conrelid::regclass::text AS table_name, c.conname, pg_get_constraintdef(c.oid) AS def
		 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
		 WHERE n.nspname = 'public' AND c.conrelid::regclass::text = ANY($1) ORDER BY 1, 2`,
		[tables],
	)
	const indexes = await db.query(
		`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = ANY($1) ORDER BY 1, 2`,
		[tables],
	)
	return { columns: columns.rows, constraints: constraints.rows, indexes: indexes.rows }
}

/**
 * What the migrations build that drizzle's schema dropped without a migration
 * dropping it: still in every database, read by nothing. Remove an entry with
 * the migration that drops it.
 */
const KNOWN_DRIFT = {
	tables: ["ai_triage_runs"],
	columns: [{ table: "ai_triage_settings", column: "fanout_enabled" }],
} as const

const isDriftColumn = (row: Record<string, unknown>) =>
	KNOWN_DRIFT.columns.some((drift) => row.table_name === drift.table && row.column_name === drift.column)

/** Postgres 17 lists a column's NOT NULL as a constraint named after it. */
const isDriftConstraint = (row: Record<string, unknown>) =>
	KNOWN_DRIFT.columns.some(
		(drift) => row.table_name === drift.table && row.conname === `${drift.table}_${drift.column}_not_null`,
	)

const isTable = (value: unknown): value is PgSchemaTable<string, any, any> =>
	typeof value === "object" && value !== null && "_tag" in value && value._tag === "Table" && "ddl" in value

/**
 * Check `tables` (or every table a module exports) against the migrations.
 * `complete` also requires them to be every table the database has.
 */
export const describeParity = (
	tables: ReadonlyArray<PgSchemaTable<string, any, any>> | Record<string, unknown>,
	options: { readonly complete?: boolean } = {},
) => {
	const list = Array.isArray(tables) ? tables : Object.values(tables).filter(isTable)
	const ormEntities = Effect.runSync(S.pgEntitiesOf(list))
	const ormTables = new Set(list.map((table) => table.name))

	describe(`effect-orm tables (${[...ormTables].sort().join(", ")})`.slice(0, 120), () => {
		it.runIf(options.complete)("cover every table drizzle-kit knows", () => {
			const drizzleTables = new Set(
				headSnapshot()
					.entities.filter((e) => e.kind === "table")
					.map((e) => e.name),
			)
			expect([...drizzleTables].filter((name) => !ormTables.has(name)).sort()).toEqual([])
			expect([...ormTables].filter((name) => !drizzleTables.has(name)).sort()).toEqual([])
		})

		it("match drizzle-kit's head snapshot entity for entity", () => {
			const snapshot = headSnapshot()
			expect(snapshot.unsupported).toEqual([])
			const drizzle = snapshot.entities.filter((entity) => ormTables.has(tableOf(entity)))
			const diff = S.diffPgSchemas(drizzle, ormEntities)
			expect(diff.ops).toEqual([])
			expect(diff.missingHints).toEqual([])
		})

		describe("against the migrated database", () => {
			const migrated = new PGlite()
			const defined = new PGlite()

			beforeAll(async () => {
				await runMigrations(migrated)
				for (const statement of S.renderPgSchema(ormEntities)) await defined.exec(statement)
			}, 120_000)

			afterAll(async () => {
				await Promise.all([migrated.close(), defined.close()])
			})

			it.runIf(options.complete)("has no table the definitions leave out", async () => {
				const { rows } = await migrated.query<{ table_name: string }>(
					`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`,
				)
				const extra = rows.map((row) => row.table_name).filter((name) => !ormTables.has(name))
				expect(extra).toEqual([...KNOWN_DRIFT.tables])
			})

			it("has the same columns, constraints and indexes", async () => {
				const tables = [...ormTables].sort()
				const [want, have] = await Promise.all([catalog(migrated, tables), catalog(defined, tables)])
				expect(have.columns).toEqual(want.columns.filter((row) => !isDriftColumn(row)))
				expect(have.constraints).toEqual(want.constraints.filter((row) => !isDriftConstraint(row)))
				expect(have.indexes).toEqual(want.indexes)
			})
		})
	})
}
