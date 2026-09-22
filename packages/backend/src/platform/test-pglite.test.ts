import { statSync } from "node:fs"
import { afterEach, describe, expect, inject, it } from "vitest"
import { buildPgliteSnapshot, snapshotPath } from "../../test/pglite-snapshot"
import { cleanupTestDbs, createTestDb, type TestDb } from "./test-pglite"

const databases: TestDb[] = []
afterEach(() => cleanupTestDbs(databases))

describe("PGlite test fixture", () => {
	it("reuses the snapshot selected by global setup without rewriting it", async () => {
		expect(inject("pgliteSnapshot")).toBe(snapshotPath)
		const before = statSync(snapshotPath)
		await buildPgliteSnapshot()
		expect(statSync(snapshotPath).mtimeMs).toBe(before.mtimeMs)
	})

	it("shares only fixture bytes, not rows, DDL, or connection state", async () => {
		const first = createTestDb(databases)
		await first.pglite.exec(`
			CREATE TABLE fixture_isolation (value text);
			INSERT INTO fixture_isolation VALUES ('first');
			CREATE TEMP TABLE fixture_temp (value text);
			SET application_name = 'first';
		`)
		const second = createTestDb(databases)
		const result = await second.pglite.query<{
			persistent: string | null
			temporary: string | null
			application: string
		}>(`SELECT to_regclass('fixture_isolation')::text AS persistent,
			to_regclass('fixture_temp')::text AS temporary,
			current_setting('application_name') AS application`)
		expect(result.rows).toEqual([{ persistent: null, temporary: null, application: "" }])
		expect((await first.pglite.query("SELECT * FROM fixture_isolation")).rows).toEqual([
			{ value: "first" },
		])
	})
})
