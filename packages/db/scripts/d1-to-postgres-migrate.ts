#!/usr/bin/env bun
/**
 * One-off D1 (SQLite) → PlanetScale Postgres data migration for the app DB.
 *
 *   # Export the prod D1 to a local SQLite dump (or pass an existing dump):
 *   bunx wrangler d1 export maple-api --remote --output .migration/d1-dump.sql
 *
 *   DATABASE_URL="postgres://…@…:5432/postgres?sslmode=verify-full" \
 *     bun packages/db/scripts/d1-to-postgres-migrate.ts .migration/d1-dump.sql
 *
 * Real prod dumps are dominated by disposable error-history churn
 * (`error_incidents` is the biggest table by far, plus the `error_issue_events`
 * audit trail). Those rebuild from live telemetry, so by default we:
 *   - SKIP `error_incidents` entirely (filtered out before the dump is even
 *     loaded, so we don't pay to parse hundreds of thousands of rows),
 *   - PRUNE `error_issue_events` to the last 90 days,
 *   - NULL `error_issue_states.open_incident_id` (the incidents it referenced are
 *     gone; this lets the error tick open a fresh incident instead of chasing a
 *     dangling id, and keeps the cached eval state so the first tick doesn't
 *     re-notify every issue),
 *   - import everything else (incl. the core `error_issues`) in full.
 *
 * Overrides (env):
 *   IMPORT_SKIP_ERROR_HISTORY=true  skip ALL error_* churn (error_issues +
 *                                   error_incidents + error_issue_events +
 *                                   error_issue_states) — fastest import; the
 *                                   error catalog rebuilds from live telemetry
 *   IMPORT_SKIP_TABLES=a,b          extra tables to skip entirely
 *   IMPORT_KEEP_INCIDENTS=true      don't skip error_incidents
 *   IMPORT_EVENTS_SINCE_DAYS=90     0 = skip error_issue_events too; N = keep last N days
 *   IMPORT_TRUNCATE=true            TRUNCATE each target table before importing (clean reruns)
 *
 * The target Postgres MUST already have the schema applied
 * (`ps:apply-schema <branch>`). Transform: epoch-ms int → Date (timestamptz),
 * 0/1 → boolean, JSON text → parsed object (jsonb). Verifies per-table row
 * counts (against the post-prune expected counts) at the end.
 */
import { Database as SqliteDb } from "bun:sqlite"
import { createReadStream, createWriteStream, existsSync, rmSync } from "node:fs"
import { createInterface } from "node:readline"
import * as schema from "../src/schema"
import { getTableColumns, getTableName, is } from "drizzle-orm"
import { PgTable } from "drizzle-orm/pg-core"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"

// Postgres bound-param ceiling is 65535; stay well under it per batch.
const MAX_PARAMS_PER_INSERT = 45_000

const fail = (message: string): never => {
	console.error(`✗ ${message}`)
	process.exit(1)
}

const dumpPath = process.argv[2]
if (!dumpPath) fail("Usage: bun packages/db/scripts/d1-to-postgres-migrate.ts <d1-dump.sql>")
if (!existsSync(dumpPath)) fail(`Dump not found: ${dumpPath}`)

const connectionString = process.env.DATABASE_URL?.trim() || process.env.MAPLE_PG_URL?.trim()
if (!connectionString) fail("Set DATABASE_URL (or MAPLE_PG_URL) to the target Postgres")

// ── policy ────────────────────────────────────────────────────────────────
const extraSkips = (process.env.IMPORT_SKIP_TABLES ?? "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean)
const keepIncidents = process.env.IMPORT_KEEP_INCIDENTS?.trim() === "true"
const eventsSinceDays = Number(process.env.IMPORT_EVENTS_SINCE_DAYS ?? "90")
const truncateFirst = process.env.IMPORT_TRUNCATE?.trim() === "true"

const skipErrorHistory = process.env.IMPORT_SKIP_ERROR_HISTORY?.trim() === "true"
const skipTables = new Set<string>(extraSkips)
if (!keepIncidents) skipTables.add("error_incidents")
if (Number.isFinite(eventsSinceDays) && eventsSinceDays === 0) skipTables.add("error_issue_events")
if (skipErrorHistory) {
	for (const t of ["error_issues", "error_incidents", "error_issue_events", "error_issue_states"]) {
		skipTables.add(t)
	}
}

// Read-time prune: SQL column → cutoff epoch-ms. (Date.now is available in this
// plain bun script — only Workflow scripts forbid it.)
const prune = new Map<string, { column: string; sinceMs: number }>()
if (!skipTables.has("error_issue_events") && Number.isFinite(eventsSinceDays) && eventsSinceDays > 0) {
	prune.set("error_issue_events", {
		column: "created_at",
		sinceMs: Date.now() - eventsSinceDays * 24 * 60 * 60 * 1000,
	})
}

// Columns to force-null on import (their referent isn't migrated).
const nullColumns = new Map<string, ReadonlySet<string>>([
	["error_issue_states", new Set(["open_incident_id"])],
])

// FK-safe order (parents first); unlisted tables follow in declaration order.
const TABLE_ORDER = ["scrape_targets", "error_issues", "alert_rules", "alert_destinations", "dashboards"]

// ── collect schema tables ───────────────────────────────────────────────────
const tables = new Map<string, PgTable>()
for (const value of Object.values(schema)) {
	if (is(value, PgTable)) tables.set(getTableName(value), value)
}
const orderedNames = [
	...TABLE_ORDER.filter((n) => tables.has(n)),
	...[...tables.keys()].filter((n) => !TABLE_ORDER.includes(n)),
]

const transformValue = (columnType: string, raw: unknown): unknown => {
	if (raw === null || raw === undefined) return null
	switch (columnType) {
		case "PgTimestamp":
		case "PgTimestampString": {
			const ms = typeof raw === "number" ? raw : Number(raw)
			if (!Number.isFinite(ms)) fail(`Non-numeric timestamp value: ${JSON.stringify(raw)}`)
			return new Date(ms)
		}
		case "PgBoolean":
			return raw === 1 || raw === true || raw === "1" || raw === "true"
		case "PgInteger":
		case "PgSmallInt":
		case "PgBigInt53": {
			// SQLite has loose type affinity, so an INTEGER column can hold a
			// float in prod (e.g. a rate stored in last_sample_count). Postgres
			// integers reject "3876913.37…", so round at the boundary.
			const n = typeof raw === "number" ? raw : Number(raw)
			if (!Number.isFinite(n)) fail(`Non-numeric integer value: ${JSON.stringify(raw)}`)
			return Math.round(n)
		}
		case "PgJsonb":
		case "PgJson": {
			if (typeof raw !== "string") return raw
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

// ── stage 1: stream-filter the dump, dropping skipped tables' INSERTs ────────
const droppedCounts = new Map<string, number>()
const loadSqlite = async (): Promise<SqliteDb> => {
	if (skipTables.size === 0) {
		console.log(`→ Loading dump (no skips) into in-memory SQLite\n`)
		const db = new SqliteDb(":memory:")
		db.exec(await Bun.file(dumpPath).text())
		return db
	}

	const filteredPath = `${dumpPath}.filtered`
	console.log(`→ Filtering out [${[...skipTables].join(", ")}] → ${filteredPath}`)
	const skipPrefixes = [...skipTables].flatMap((t) => [`INSERT INTO "${t}"`, `INSERT INTO ${t} `])
	for (const t of skipTables) droppedCounts.set(t, 0)

	const out = createWriteStream(filteredPath)
	const rl = createInterface({ input: createReadStream(dumpPath), crlfDelay: Infinity })
	for await (const line of rl) {
		const trimmed = line.trimStart()
		const skip = skipPrefixes.find((p) => trimmed.startsWith(p))
		if (skip) {
			const table = skip.slice('INSERT INTO "'.length).replace(/".*/, "").replace(/ .*/, "")
			droppedCounts.set(table, (droppedCounts.get(table) ?? 0) + 1)
			continue
		}
		out.write(`${line}\n`)
	}
	await new Promise<void>((resolveClose) => out.end(resolveClose))
	for (const [t, n] of droppedCounts) console.log(`  · skipped ${n.toLocaleString()} rows from ${t}`)

	console.log(`\n→ Loading filtered dump into in-memory SQLite\n`)
	const db = new SqliteDb(":memory:")
	db.exec(await Bun.file(filteredPath).text())
	rmSync(filteredPath, { force: true })
	return db
}

const sqlite = await loadSqlite()
const sql = postgres(connectionString as string, { max: 4 })
const db = drizzle(sql, { schema })

const tableExists = (name: string): boolean => {
	const row = sqlite
		.query(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`)
		.get(name) as unknown
	return row != null
}

const countRows = (name: string): number => {
	const p = prune.get(name)
	const where = p ? ` WHERE "${p.column}" >= ${p.sinceMs}` : ""
	const row = sqlite.query(`SELECT count(*) AS n FROM "${name}"${where}`).get() as { n: number }
	return row.n
}

// ── stage 2: import, paged by rowid, batched to the param ceiling ────────────
console.log(`→ Importing ${orderedNames.length} tables into Postgres\n`)
let mismatch = false

for (const name of orderedNames) {
	if (skipTables.has(name)) {
		const dropped = droppedCounts.get(name) ?? 0
		console.log(`  – ${name.padEnd(34)} SKIPPED (${dropped.toLocaleString()} rows in dump)`)
		continue
	}
	if (!tableExists(name)) {
		console.log(`  · ${name.padEnd(34)} not in dump`)
		continue
	}

	const table = tables.get(name)!
	const cols = Object.entries(getTableColumns(table)).map(([tsKey, col]) => ({
		tsKey,
		sqlName: (col as { name: string }).name,
		columnType: (col as { columnType: string }).columnType,
	}))
	const nulls = nullColumns.get(name) ?? new Set<string>()
	const batchRows = Math.max(1, Math.floor(MAX_PARAMS_PER_INSERT / cols.length))
	const p = prune.get(name)
	const total = countRows(name)
	if (truncateFirst) await sql.unsafe(`TRUNCATE TABLE "${name}" CASCADE`)
	if (total === 0) {
		console.log(`  ✓ ${name.padEnd(34)} 0 rows`)
		continue
	}

	const whereClauses: string[] = []
	if (p) whereClauses.push(`"${p.column}" >= ${p.sinceMs}`)
	let lastRid = 0
	let written = 0
	for (;;) {
		const where = [...whereClauses, `rowid > ${lastRid}`].join(" AND ")
		const page = sqlite
			.query(`SELECT rowid AS __rid, * FROM "${name}" WHERE ${where} ORDER BY rowid LIMIT ${batchRows}`)
			.all() as Array<Record<string, unknown>>
		if (page.length === 0) break
		lastRid = page[page.length - 1].__rid as number

		const mapped = page.map((row) => {
			const obj: Record<string, unknown> = {}
			for (const { tsKey, sqlName, columnType } of cols) {
				obj[tsKey] = nulls.has(sqlName) ? null : transformValue(columnType, row[sqlName])
			}
			return obj
		})
		// biome-ignore lint: dynamic table insert
		await db.insert(table).values(mapped as never)
		written += page.length
		process.stdout.write(`\r  … ${name.padEnd(34)} ${written.toLocaleString()}/${total.toLocaleString()}`)
		if (page.length < batchRows) break
	}
	process.stdout.write(`\r  ✓ ${name.padEnd(34)} ${written.toLocaleString()} rows           \n`)
}

// ── stage 3: realign identity sequences ──────────────────────────────────────
for (const name of orderedNames) {
	if (skipTables.has(name) || !tableExists(name)) continue
	for (const col of Object.values(getTableColumns(tables.get(name)!))) {
		const c = col as { name: string; columnType: string }
		if (c.columnType === "PgInteger" || c.columnType === "PgBigInt53" || c.columnType === "PgSerial") {
			await sql.unsafe(
				`SELECT setval(seq, COALESCE((SELECT MAX("${c.name}") FROM "${name}"), 1), true)
				 FROM (SELECT pg_get_serial_sequence('"${name}"', '${c.name}') AS seq) s WHERE seq IS NOT NULL`,
			)
		}
	}
}

// ── stage 4: verify counts (post-prune expectations) ─────────────────────────
console.log(`\n→ Verifying row counts (expected vs postgres)\n`)
for (const name of orderedNames) {
	if (skipTables.has(name) || !tableExists(name)) continue
	const expected = countRows(name)
	const pgRow = await sql.unsafe(`SELECT count(*)::int AS n FROM "${name}"`)
	const pgN = Number((pgRow[0] as { n: number }).n)
	const ok = expected === pgN
	if (!ok) mismatch = true
	console.log(
		`  ${ok ? "✓" : "✗"} ${name.padEnd(34)} expected ${expected.toLocaleString()}  postgres ${pgN.toLocaleString()}`,
	)
}

await sql.end()
sqlite.close()

if (mismatch) fail("\nRow-count mismatch — import is NOT complete. Re-run with IMPORT_TRUNCATE=true.")
console.log(`\n✓ Import complete; all kept-table counts match.`)
