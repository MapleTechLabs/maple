#!/usr/bin/env bun
/**
 * One-off D1 (SQLite) → PlanetScale Postgres data migration for the app DB.
 *
 *   # Export the prod D1 to a local SQLite dump (or pass an existing dump):
 *   bunx wrangler d1 export maple-api --remote --output .migration/d1-dump.sql
 *
 *   # Dry-run into a throwaway PS branch until verification is green:
 *   DATABASE_URL="postgres://…@…:5432/maple-api?sslmode=require" \
 *     bun packages/db/scripts/d1-to-postgres-migrate.ts .migration/d1-dump.sql
 *
 * Reads the dump into an in-memory bun:sqlite (no network during transform,
 * fully rerunnable), then for every table in the new Drizzle Postgres schema:
 *   - reads rows by SQL column name from SQLite,
 *   - transforms per the NEW column type (epoch-ms int → Date for timestamptz,
 *     0/1 → boolean, JSON text → parsed object for jsonb, passthrough else),
 *   - inserts via drizzle/postgres-js in FK-safe order, chunked.
 * Then realigns identity sequences and verifies per-table row counts.
 *
 * The target Postgres MUST already have the schema applied
 * (`DATABASE_URL=… bun run --cwd packages/db db:migrate`). The dump is assumed
 * post-0012/0013 (prod D1 ran those data migrations at boot); rows in a legacy
 * shape will fail the jsonb/Schema decode loudly rather than import silently.
 */
import { Database as SqliteDb } from "bun:sqlite"
import { readFileSync } from "node:fs"
import * as schema from "../src/schema"
import { getTableColumns, getTableName, is } from "drizzle-orm"
import { PgTable } from "drizzle-orm/pg-core"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"

const CHUNK_SIZE = 1000

/**
 * FK-safe insert order (parents first). The only FK today is
 * scrape_target_checks → scrape_targets; everything else is order-independent,
 * but we order the known parents defensively. Any table not listed here is
 * imported afterward in schema-declaration order.
 */
const TABLE_ORDER = [
	"scrape_targets",
	"error_issues",
	"alert_rules",
	"alert_destinations",
	"dashboards",
] as const

const fail = (message: string): never => {
	console.error(`✗ ${message}`)
	process.exit(1)
}

const dumpPath = process.argv[2]
if (!dumpPath) fail("Usage: bun scripts/d1-to-postgres-migrate.ts <d1-dump.sql>")

const connectionString = process.env.DATABASE_URL?.trim() || process.env.MAPLE_PG_MIGRATE_URL?.trim()
if (!connectionString) fail("Set DATABASE_URL (or MAPLE_PG_MIGRATE_URL) to the target Postgres")

// Collect every pgTable exported from the schema barrel, keyed by SQL name.
const tables = new Map<string, PgTable>()
for (const value of Object.values(schema)) {
	if (is(value, PgTable)) {
		tables.set(getTableName(value), value)
	}
}

const orderedTableNames = [
	...TABLE_ORDER.filter((name) => tables.has(name)),
	...[...tables.keys()].filter((name) => !TABLE_ORDER.includes(name as (typeof TABLE_ORDER)[number])),
]

/** Transform one SQLite cell to the value drizzle expects for the new column. */
const transformValue = (columnType: string, raw: unknown): unknown => {
	if (raw === null || raw === undefined) return null
	switch (columnType) {
		case "PgTimestamp":
		case "PgTimestampString": {
			// SQLite stored epoch-ms integers (or floats from unixepoch('subsec')*1000).
			const ms = typeof raw === "number" ? raw : Number(raw)
			if (!Number.isFinite(ms)) fail(`Non-numeric timestamp value: ${JSON.stringify(raw)}`)
			return new Date(ms)
		}
		case "PgBoolean":
			return raw === 1 || raw === true || raw === "1" || raw === "true"
		case "PgJsonb":
		case "PgJson": {
			if (typeof raw !== "string") return raw // already structured
			try {
				return JSON.parse(raw)
			} catch (error) {
				return fail(`Unparseable JSON for jsonb column: ${JSON.stringify(raw)} (${String(error)})`)
			}
		}
		default:
			return raw
	}
}

const sqlite = new SqliteDb(":memory:")
sqlite.exec(readFileSync(dumpPath, "utf8"))

const sql = postgres(connectionString, { max: 4 })
const db = drizzle(sql, { schema })

const sqliteCount = (table: string): number => {
	try {
		const row = sqlite.query(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number } | undefined
		return row?.n ?? 0
	} catch {
		return 0 // table absent in the dump (e.g. _maple_data_migrations) → nothing to import
	}
}

const importTable = async (tableName: string): Promise<{ read: number; written: number }> => {
	const table = tables.get(tableName)!
	const columns = getTableColumns(table)
	// Map TS property name → SQL column name + columnType, for the transform.
	const colMeta = Object.entries(columns).map(([tsKey, col]) => ({
		tsKey,
		sqlName: (col as { name: string }).name,
		columnType: (col as { columnType: string }).columnType,
	}))

	let rows: Array<Record<string, unknown>>
	try {
		rows = sqlite.query(`SELECT * FROM "${tableName}"`).all() as Array<Record<string, unknown>>
	} catch {
		return { read: 0, written: 0 } // not in dump
	}
	if (rows.length === 0) return { read: 0, written: 0 }

	const mapped = rows.map((row) => {
		const out: Record<string, unknown> = {}
		for (const { tsKey, sqlName, columnType } of colMeta) {
			out[tsKey] = transformValue(columnType, row[sqlName])
		}
		return out
	})

	let written = 0
	for (let i = 0; i < mapped.length; i += CHUNK_SIZE) {
		const chunk = mapped.slice(i, i + CHUNK_SIZE)
		// biome-ignore lint: dynamic table insert
		await db.insert(table).values(chunk as never)
		written += chunk.length
	}
	return { read: rows.length, written }
}

console.log(`→ Importing ${orderedTableNames.length} tables from ${dumpPath}\n`)

let totalRead = 0
let mismatch = false
for (const tableName of orderedTableNames) {
	const { read, written } = await importTable(tableName)
	totalRead += written
	console.log(`  ${tableName.padEnd(38)} read ${read}  written ${written}`)
}

// Realign identity sequences so future inserts don't collide with imported ids.
for (const tableName of orderedTableNames) {
	const columns = getTableColumns(tables.get(tableName)!)
	for (const col of Object.values(columns)) {
		const c = col as { name: string; columnType: string }
		if (c.columnType === "PgInteger" || c.columnType === "PgBigInt53" || c.columnType === "PgSerial") {
			// Only identity/serial columns have a sequence; pg_get_serial_sequence
			// returns NULL for plain integers, making this a safe no-op.
			await sql.unsafe(
				`SELECT setval(seq, COALESCE((SELECT MAX("${c.name}") FROM "${tableName}"), 1), true)
				 FROM (SELECT pg_get_serial_sequence('"${tableName}"', '${c.name}') AS seq) s
				 WHERE seq IS NOT NULL`,
			)
		}
	}
}

console.log("\n→ Verifying row counts (sqlite vs postgres)\n")
for (const tableName of orderedTableNames) {
	const sqliteN = sqliteCount(tableName)
	const pgRow = await sql.unsafe(`SELECT count(*)::int AS n FROM "${tableName}"`)
	const pgN = Number((pgRow[0] as { n: number }).n)
	const ok = sqliteN === pgN
	if (!ok) mismatch = true
	console.log(`  ${ok ? "✓" : "✗"} ${tableName.padEnd(38)} sqlite ${sqliteN}  postgres ${pgN}`)
}

await sql.end()
sqlite.close()

if (mismatch) fail("\nRow-count mismatch — import is NOT complete. Truncate the target and rerun.")
console.log(`\n✓ Imported ${totalRead} rows; all table counts match.`)
