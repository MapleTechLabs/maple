import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import schemaSql from "../src/server/schema/local-schema.sql" with { type: "text" }
import { Effect, Result } from "effect"
import { Chdb } from "../src/server/chdb"
import { type InsertBatch, InsertBatcher } from "../src/server/insert-batcher"
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
	const batcher = new InsertBatcher(db)
	return { statements, insert: (batches: ReadonlyArray<InsertBatch>) => outcome(batcher.insert(batches)) }
}

/** `{ accepted }` on success, `{ accepted, failure: { datasource } }` on failure. */
const outcome = (effect: ReturnType<InsertBatcher["insert"]>) =>
	Effect.runPromise(Effect.result(effect)).then((result) =>
		Result.isSuccess(result)
			? { accepted: result.success }
			: { accepted: result.failure.accepted, failure: { datasource: result.failure.datasource } },
	)

describe("InsertBatcher", () => {
	test("exports queued together share one insert, and each counts only its own rows", async () => {
		const { statements, insert } = recording()
		const outcomes = await Promise.all([
			insert([{ datasource: "logs", ndjson: rows("a1") }]),
			insert([{ datasource: "logs", ndjson: rows("b1", "b2") }]),
			insert([{ datasource: "logs", ndjson: rows("c1", "c2", "c3") }]),
		])
		expect(outcomes).toEqual([{ accepted: 1 }, { accepted: 2 }, { accepted: 3 }])
		expect(statements).toHaveLength(1)
		for (const body of ["a1", "b2", "c3"]) expect(statements[0]).toContain(body)
	})

	test("a failed insert fails the exports in it, and their later rows are not inserted", async () => {
		const { statements, insert } = recording((sql) => sql.startsWith("INSERT INTO logs"))
		const [a, b] = await Promise.all([
			insert([
				{ datasource: "logs", ndjson: rows("a-log") },
				{ datasource: "traces", ndjson: rows("a-span") },
			]),
			insert([{ datasource: "traces", ndjson: rows("b-span") }]),
		])
		expect(a).toMatchObject({ accepted: 0, failure: { datasource: "logs" } })
		expect(b).toEqual({ accepted: 1 })
		const traces = statements.filter((sql) => sql.startsWith("INSERT INTO traces"))
		expect(traces).toHaveLength(1)
		expect(traces[0]).toContain("b-span")
		expect(traces[0]).not.toContain("a-span")
	})

	test("an export meets its datasources in its own order, whatever the exports queued before it carry", async () => {
		const { statements, insert } = recording((sql) => sql.startsWith("INSERT INTO metrics_gauge"))
		const [a, b] = await Promise.all([
			insert([
				{ datasource: "metrics_histogram", ndjson: rows("a-histogram") },
				{ datasource: "metrics_sum", ndjson: rows("a-sum") },
			]),
			insert([
				{ datasource: "metrics_gauge", ndjson: rows("b-gauge") },
				{ datasource: "metrics_sum", ndjson: rows("b-sum") },
			]),
		])
		expect(a).toEqual({ accepted: 2 })
		expect(b).toMatchObject({ accepted: 0, failure: { datasource: "metrics_gauge" } })
		expect(statements.some((sql) => sql.includes("b-sum"))).toBe(false)
	})

	test("a row the engine refuses fails only its own export, not the others sharing its insert", async () => {
		const { statements, insert } = recording((sql) => sql.includes("bad"))
		const [a, b, c] = await Promise.all([
			insert([{ datasource: "logs", ndjson: rows("a1") }]),
			insert([
				{ datasource: "logs", ndjson: rows("bad") },
				{ datasource: "traces", ndjson: rows("b-span") },
			]),
			insert([{ datasource: "logs", ndjson: rows("c1", "c2") }]),
		])
		expect([a, b, c]).toEqual([
			{ accepted: 1 },
			{ accepted: 0, failure: { datasource: "logs" } },
			{ accepted: 2 },
		])
		expect(statements.some((sql) => sql.includes("b-span"))).toBe(false)
	})

	test("an insert failing for every export is retried alone only until two retries fail", async () => {
		const { statements, insert } = recording(() => true)
		const outcomes = await Promise.all(
			["a", "b", "c", "d"].map((body) => insert([{ datasource: "logs", ndjson: rows(body) }])),
		)
		for (const outcome of outcomes)
			expect(outcome).toEqual({ accepted: 0, failure: { datasource: "logs" } })
		expect(statements).toHaveLength(3)
	})

	test("an export naming a datasource with no insert mapping fails at once and holds up no other", async () => {
		const { statements, insert } = recording()
		const [unknown, known] = await Promise.all([
			insert([
				{ datasource: "logs", ndjson: rows("u1") },
				{ datasource: "nope", ndjson: rows("u2") },
			]),
			insert([{ datasource: "logs", ndjson: rows("k1") }]),
		])
		expect(unknown).toEqual({ accepted: 0, failure: { datasource: "nope" } })
		expect(known).toEqual({ accepted: 1 })
		expect(statements.some((sql) => sql.includes("u1"))).toBe(false)
	})

	test("a statement's worth counted in UTF-8 bytes is inserted without waiting for the window", async () => {
		const { statements, insert } = recording()
		// Three UTF-8 bytes per code unit: a third of the budget in string length.
		const pending = insert([
			{ datasource: "logs", ndjson: rows("界".repeat(MAX_ESCAPED_PAYLOAD_BYTES / 3)) },
		])
		expect(statements).toHaveLength(1)
		expect(await pending).toEqual({ accepted: 1 })
	})

	test("a statement's worth of rows is inserted without waiting for the window", async () => {
		const { statements, insert } = recording()
		const pending = insert([{ datasource: "logs", ndjson: rows("x".repeat(MAX_ESCAPED_PAYLOAD_BYTES)) }])
		expect(statements).toHaveLength(1)
		expect(await pending).toEqual({ accepted: 1 })
	})
})

describeWithChdb("InsertBatcher against the engine", () => {
	let root = ""
	let db: Chdb
	let inserts: InsertBatcher

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "maple-insert-batcher-"))
		db = Chdb.open({ dataDir: join(root, "data"), schemaSql })
		inserts = InsertBatcher.attach(db)
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
		const outcomes = ["one", "two", "three"].map((body) => outcome(inserts.insert(logExport(body))))
		expect(db.query("SELECT count() FROM logs", "TSVRaw").trim()).toBe("3")
		expect(await Promise.all(outcomes)).toEqual([{ accepted: 1 }, { accepted: 1 }, { accepted: 1 }])
	})
})
