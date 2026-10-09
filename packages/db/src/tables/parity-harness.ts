// The effect-orm table definitions must describe exactly the database the
// migrations build. Two checks: the definitions against the head snapshot
// (what `effect-orm generate` diffs against, so a mismatch is a migration
// nobody wrote), and a live comparison of the catalog Postgres deparses for a
// database migrated by the bundled migrations and one created from the
// definitions alone.
import { PGlite } from "@electric-sql/pglite"
import * as Kit from "@maple-dev/effect-orm/kit"
import * as Migrate from "@maple-dev/effect-orm/migrate"
import * as S from "@maple-dev/effect-orm/schema"
import { Effect, Schema } from "effect"
import type { ColumnDefs, PgSchemaTable } from "@maple-dev/effect-orm/postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { bundledMigrations, runMigrations } from "../migrate"

/** The migrations folder as `effect-orm generate` reads it. */
const folder = () => Effect.runPromise(Effect.flatMap(bundledMigrations, Kit.analyze))

const isPgEntity = Schema.is(S.PgSchemaEntity)

/** The schema the newest snapshot records. */
const headEntities = async (): Promise<ReadonlyArray<S.PgSchemaEntity>> =>
	(await folder()).base.filter(isPgEntity)

const LEDGER = new Set<string>(Object.values(Migrate.LEDGER_TABLES))

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

const isTable = (value: unknown): value is PgSchemaTable<string, ColumnDefs, string> =>
	typeof value === "object" && value !== null && "_tag" in value && value._tag === "Table" && "ddl" in value

/**
 * Check `tables` (or every table a module exports) against the migrations.
 * `complete` also requires them to be every table the database has.
 */
export const describeParity = (
	tables: ReadonlyArray<PgSchemaTable<string, ColumnDefs, string>> | Record<string, unknown>,
	options: { readonly complete?: boolean } = {},
) => {
	const list = Array.isArray(tables) ? tables : Object.values(tables).filter(isTable)
	const ormEntities = Effect.runSync(S.pgEntitiesOf(list))
	const ormTables = new Set(list.map((table) => table.name))

	describe(`effect-orm tables (${[...ormTables].sort().join(", ")})`.slice(0, 120), () => {
		it.runIf(options.complete)("leave the migrations folder consistent", async () => {
			const analysis = await folder()
			expect(analysis.problems).toEqual([])
			expect(analysis.leaves).toHaveLength(1)
		})

		it.runIf(options.complete)("cover every table the head snapshot knows", async () => {
			const snapshotTables = new Set(
				(await headEntities()).filter((e) => e.kind === "table").map((e) => e.name),
			)
			expect([...snapshotTables].filter((name) => !ormTables.has(name)).sort()).toEqual([])
			expect([...ormTables].filter((name) => !snapshotTables.has(name)).sort()).toEqual([])
		})

		it("match the head snapshot entity for entity, so generate has nothing to write", async () => {
			const head = (await headEntities()).filter((entity) => ormTables.has(tableOf(entity)))
			const diff = S.diffPgSchemas(head, ormEntities)
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
				const extra = rows
					.map((row) => row.table_name)
					.filter((name) => !ormTables.has(name) && !LEDGER.has(name))
				expect(extra).toEqual([])
			})

			it("has the same columns, constraints and indexes", async () => {
				const tables = [...ormTables].sort()
				const [want, have] = await Promise.all([catalog(migrated, tables), catalog(defined, tables)])
				expect(have.columns).toEqual(want.columns)
				expect(have.constraints).toEqual(want.constraints)
				expect(have.indexes).toEqual(want.indexes)
			})
		})
	})
}
