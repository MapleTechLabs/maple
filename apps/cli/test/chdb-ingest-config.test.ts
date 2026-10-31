import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Chdb, writeIngestConfig } from "../src/server/chdb"
import { describeWithChdb } from "./libchdb-test-support"

// chDB silently ignores `--merge_tree.*` arguments, so the only proof the ingest
// defaults apply is reading them back from the engine.
describeWithChdb("chDB ingest config", () => {
	let root = ""
	let db: Chdb | undefined

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "maple-ingest-config-"))
		const configFile = join(root, "chdb-config.xml")
		writeIngestConfig(configFile)
		db = Chdb.open({ dataDir: join(root, "data"), schemaSql: "", bootstrapSchema: false, configFile })
	})

	afterAll(() => {
		db?.close()
		rmSync(root, { recursive: true, force: true })
	})

	const value = (table: string, name: string) =>
		db?.query(`SELECT value FROM system.${table} WHERE name = '${name}'`, "TSVRaw").trim()

	test("outdated parts are cleaned every second on a small pool", () => {
		expect(value("merge_tree_settings", "cleanup_delay_period")).toBe("1")
		expect(value("merge_tree_settings", "cleanup_threads")).toBe("4")
	})

	test("an insert pushes to its views in parallel", () => {
		expect(value("settings", "parallel_view_processing")).toBe("1")
	})
})
