import { describe, it } from "@effect/vitest"
import { ok, strictEqual } from "node:assert"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { Chdb } from "../src/server/chdb"
import { validateCheckpointDataDir } from "../src/server/checkpoints"
import schemaSql from "../src/server/schema/local-schema.sql" with { type: "text" }

// Needs a real libchdb; skipped where none is installed.
const libchdbAvailable =
	process.env.MAPLE_LIBCHDB !== undefined ||
	existsSync(join(homedir(), ".maple", "bin", "libchdb.so")) ||
	existsSync(join(homedir(), ".maple", "bin", "libchdb.dylib"))

const countRows = (db: Chdb, table: string): number => {
	const line = db.query(`SELECT count() AS n FROM ${table}`).trim()
	return Number(JSON.parse(line).n)
}

describe.skipIf(!libchdbAvailable)("row counts across chDB opens", () => {
	it("keeps expired rows through a merge while TTL merges are stopped", () => {
		const root = mkdtempSync(join(tmpdir(), "maple-ttl-freeze-"))
		const db = Chdb.open({ dataDir: join(root, "data"), schemaSql: "SELECT 1", bootstrapSchema: false })
		try {
			db.exec(
				"CREATE TABLE expiring (d DateTime) ENGINE = MergeTree ORDER BY d TTL toDate(d) + INTERVAL 30 DAY",
			)
			db.exec("SYSTEM STOP TTL MERGES")
			db.exec("INSERT INTO expiring VALUES (now() - INTERVAL 400 DAY)")
			db.exec("INSERT INTO expiring VALUES (now() - INTERVAL 401 DAY)")
			// An ordinary merge that meets expired rows keeps them: what migrations rely on.
			db.exec("OPTIMIZE TABLE expiring FINAL")
			strictEqual(countRows(db, "expiring"), 2)
			db.exec("SYSTEM START TTL MERGES")
			db.exec("OPTIMIZE TABLE expiring FINAL")
			strictEqual(countRows(db, "expiring"), 0)
		} finally {
			db.close()
			rmSync(root, { recursive: true, force: true })
		}
	})

	it("validates a store in the reopen probe with every background merge stopped", () => {
		const root = mkdtempSync(join(tmpdir(), "maple-probe-freeze-"))
		const dataDir = join(root, "data")
		try {
			Chdb.open({ dataDir, schemaSql }).close()
			const validation = validateCheckpointDataDir(dataDir)
			strictEqual(validation.traces, 0)
			ok(validation.materializedViews > 0)
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})
})
