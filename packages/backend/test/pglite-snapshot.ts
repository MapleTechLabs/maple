import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { serialize } from "node:v8"
import { PGlite } from "@electric-sql/pglite"
import { listBundledMigrations, readBundledMigrationsSql, runMigrations } from "@maple/db/migrate"
import { capturePgliteFixture } from "./pglite-fixture"

/**
 * Migrate once, then cache the indexed filesystem for FixtureMemoryFS. Restoring
 * a tar per test spent more time parsing and walking paths than running SQL:
 * the fixture contains 1,375 files but only 27 directories. Indexing once cut
 * measured Linux database boot from 118ms to 63ms without sharing live databases.
 *
 * Keep the real Drizzle migrator: raw concatenated SQL would omit the journal,
 * and a test replaying migrations would try to create existing tables again.
 */

// A snapshot is tied to the engine as well as the SQL. Migration directory
// names are Drizzle's journal timestamps, so renaming one must invalidate it too.
const snapshotKey = createHash("sha256")
	.update("maple-pglite-snapshot-v3")
	.update(process.versions.v8)
	.update(
		readFileSync(
			join(dirname(createRequire(import.meta.url).resolve("@electric-sql/pglite")), "../package.json"),
		),
	)
	.update(JSON.stringify(listBundledMigrations().map(({ name }) => name)))
	.update(readBundledMigrationsSql())
	.digest("hex")
	.slice(0, 16)

const CACHE_DIR = join(tmpdir(), "maple-pglite-snapshots")
export const snapshotPath = join(CACHE_DIR, `schema-${snapshotKey}.bin`)

/**
 * Build the snapshot at `snapshotPath` unless an identically-keyed one is already
 * there. Called from the vitest globalSetup, once, before any worker starts.
 */
export const buildPgliteSnapshot = async (): Promise<void> => {
	if (existsSync(snapshotPath)) return
	mkdirSync(CACHE_DIR, { recursive: true })

	const db = new PGlite()
	try {
		await runMigrations(db)
		const dump = serialize(capturePgliteFixture(db))
		// Write-then-rename: concurrent vitest invocations (turbo runs several
		// packages' suites at once) must never observe a half-written fixture.
		const staging = `${snapshotPath}.${process.pid}.${randomUUID()}.tmp`
		writeFileSync(staging, dump)
		renameSync(staging, snapshotPath)
	} finally {
		await db.close()
	}
}
