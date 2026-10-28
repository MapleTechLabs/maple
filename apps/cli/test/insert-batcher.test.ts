import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import schemaSql from "../src/server/schema/local-schema.sql" with { type: "text" }
import { Chdb } from "../src/server/chdb"
import { InsertBatcher } from "../src/server/insert-batcher"
import { MAX_ESCAPED_PAYLOAD_BYTES } from "../src/server/inserts"
import { encodeLogs } from "../src/server/otlp/encode"
import { describeWithChdb } from "./libchdb-test-support"

const rows = (...bodies: string[]) => bodies.map((body) => JSON.stringify({ body })).join("\n")

const recording = (fails: (sql: string) => boolean = () => false) => {
	const statements: string[] = []
	const db = {
		exec: (sql: string) => {
			statements.push(sql)
			if (fails(sql)) throw new Error("insert refused")
		},
	}
	return { statements, inserts: new InsertBatcher(db) }
}

describe("InsertBatcher", () => {
	test("exports queued together share one insert, and each counts only its own rows", async () => {
		const { statements, inserts } = recording()
		const outcomes = await Promise.all([
			inserts.insert([{ datasource: "logs", ndjson: rows("a1") }]),
			inserts.insert([{ datasource: "logs", ndjson: rows("b1", "b2") }]),
			inserts.insert([{ datasource: "logs", ndjson: rows("c1", "c2", "c3") }]),
		])
		expect(outcomes).toEqual([{ accepted: 1 }, { accepted: 2 }, { accepted: 3 }])
		expect(statements).toHaveLength(1)
		for (const body of ["a1", "b2", "c3"]) expect(statements[0]).toContain(body)
	})

	test("a failed insert fails the exports in it, and their later rows are not inserted", async () => {
		const { statements, inserts } = recording((sql) => sql.startsWith("INSERT INTO logs"))
		const [a, b] = await Promise.all([
			inserts.insert([
				{ datasource: "logs", ndjson: rows("a-log") },
				{ datasource: "traces", ndjson: rows("a-span") },
			]),
			inserts.insert([{ datasource: "traces", ndjson: rows("b-span") }]),
		])
		expect(a).toMatchObject({ accepted: 0, failure: { datasource: "logs" } })
		expect(b).toEqual({ accepted: 1 })
		const traces = statements.filter((sql) => sql.startsWith("INSERT INTO traces"))
		expect(traces).toHaveLength(1)
		expect(traces[0]).toContain("b-span")
		expect(traces[0]).not.toContain("a-span")
	})

	test("an export meets its datasources in its own order, whatever the exports queued before it carry", async () => {
		const { statements, inserts } = recording((sql) => sql.startsWith("INSERT INTO metrics_gauge"))
		const [a, b] = await Promise.all([
			inserts.insert([
				{ datasource: "metrics_histogram", ndjson: rows("a-histogram") },
				{ datasource: "metrics_sum", ndjson: rows("a-sum") },
			]),
			inserts.insert([
				{ datasource: "metrics_gauge", ndjson: rows("b-gauge") },
				{ datasource: "metrics_sum", ndjson: rows("b-sum") },
			]),
		])
		expect(a).toEqual({ accepted: 2 })
		expect(b).toMatchObject({ accepted: 0, failure: { datasource: "metrics_gauge" } })
		expect(statements.some((sql) => sql.includes("b-sum"))).toBe(false)
	})

	test("a statement's worth of rows is inserted without waiting for the window", async () => {
		const { statements, inserts } = recording()
		const outcome = inserts.insert([
			{ datasource: "logs", ndjson: rows("x".repeat(MAX_ESCAPED_PAYLOAD_BYTES)) },
		])
		expect(statements).toHaveLength(1)
		expect(await outcome).toEqual({ accepted: 1 })
	})
})

describeWithChdb("InsertBatcher against the engine", () => {
	let root = ""
	let db: Chdb
	let inserts: InsertBatcher

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "maple-insert-batcher-"))
		db = Chdb.open({ dataDir: join(root, "data"), schemaSql })
		inserts = new InsertBatcher(db)
		db.beforeEachStatement(() => inserts.flush())
	})

	afterAll(() => {
		db?.close()
		if (root) rmSync(root, { recursive: true, force: true })
	})

	// Stamped now: a record without a time lands in 1970, and the raw-telemetry TTL drops it.
	const logExport = (body: string) =>
		encodeLogs({
			resourceLogs: [
				{
					scopeLogs: [
						{
							logRecords: [
								{
									timeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
									body: { stringValue: body },
								},
							],
						},
					],
				},
			],
		})

	test("a query reads the rows of exports still waiting for their insert", async () => {
		const outcomes = ["one", "two", "three"].map((body) => inserts.insert(logExport(body)))
		expect(db.query("SELECT count() FROM logs", "TSVRaw").trim()).toBe("3")
		expect(await Promise.all(outcomes)).toEqual([{ accepted: 1 }, { accepted: 1 }, { accepted: 1 }])
	})
})
