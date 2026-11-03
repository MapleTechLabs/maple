import { describe, expect, it } from "vitest"
import {
	buildBatchedInsertStatements,
	buildInsertSql,
	buildInsertStatements,
} from "@maple/local-server/inserts"
import { Array as Arr, String as Str } from "effect"

const line = (i: number, pad = 0) => JSON.stringify({ body: `row-${i}${Str.repeat(pad)("x")}` })

describe("buildInsertStatements", () => {
	it("emits a single statement for a small batch, identical to buildInsertSql", () => {
		const ndjson = Arr.join([line(1), line(2), line(3)], "\n")
		const statements = buildInsertStatements("logs", ndjson)
		expect(statements).toHaveLength(1)
		expect(statements[0]?.rowCount).toBe(3)
		expect(statements[0]?.sql).toBe(buildInsertSql("logs", ndjson))
	})

	it("ignores empty lines when counting rows", () => {
		const statements = buildInsertStatements("logs", `${line(1)}\n\n${line(2)}\n`)
		expect(statements).toHaveLength(1)
		expect(statements[0]?.rowCount).toBe(2)
	})

	// Regression: a large OTLP logs batch inlined into one statement exceeded
	// chDB's default max_query_size (~256KB) → "Code: 62 … Max query size
	// exceeded". Batches must be split on line boundaries under the budget.
	it("splits a large batch into multiple statements under the size budget", () => {
		const rows = Array.from({ length: 50 }, (_, i) => line(i, 10_000))
		const statements = buildInsertStatements("logs", Arr.join(rows, "\n"))
		expect(statements.length).toBeGreaterThan(1)
		expect(Arr.reduce(statements, 0, (n, s) => n + s.rowCount)).toBe(50)
		for (const statement of statements) {
			expect(Buffer.byteLength(statement.sql, "utf8")).toBeLessThan(256 * 1024)
		}
	})

	it("splits only on line boundaries — concatenated payloads round-trip", () => {
		const rows = Array.from({ length: 50 }, (_, i) => line(i, 10_000))
		const statements = buildInsertStatements("logs", Arr.join(rows, "\n"))
		const payloads = Arr.map(statements, (s) => {
			const start = s.sql.lastIndexOf(", '") + 3
			return Str.slice(start, -2)(s.sql)
		})
		expect(Arr.join(payloads, "\n")).toBe(Arr.join(rows, "\n"))
	})

	it("passes a single oversized line through as its own statement", () => {
		const huge = line(0, 300_000)
		const statements = buildInsertStatements("logs", Arr.join([line(1), huge, line(2)], "\n"))
		expect(Arr.map(statements, (s) => s.rowCount)).toEqual([1, 1, 1])
		expect(statements[1]?.sql).toContain(Str.repeat(300_000)("x"))
	})

	it("budgets on escaped bytes, not raw bytes", () => {
		// Each backslash escapes to two characters; 60 rows of ~3.4KB raw escape
		// to ~6.7KB each (~400KB total), forcing at least a three-way split.
		const rows = Array.from({ length: 60 }, () => JSON.stringify({ body: Str.repeat(3_333)("\\") }))
		const statements = buildInsertStatements("logs", Arr.join(rows, "\n"))
		expect(statements.length).toBeGreaterThan(2)
		for (const statement of statements) {
			expect(Buffer.byteLength(statement.sql, "utf8")).toBeLessThan(256 * 1024)
		}
	})

	it("throws on an unknown datasource", () => {
		expect(() => buildInsertStatements("nope", line(1))).toThrow("no insert mapping")
	})
})

describe("buildBatchedInsertStatements", () => {
	it("puts batches that fit together into one statement, identical to one batch of all their rows", () => {
		const statements = buildBatchedInsertStatements("logs", [
			{ owner: "a", ndjson: line(1) },
			{ owner: "b", ndjson: Arr.join([line(2), line(3)], "\n") },
		])
		expect(statements).toHaveLength(1)
		expect(statements[0]?.sql).toBe(buildInsertSql("logs", Arr.join([line(1), line(2), line(3)], "\n")))
		expect(statements[0]?.parts).toEqual([
			{ owner: "a", rowCount: 1 },
			{ owner: "b", rowCount: 2 },
		])
	})

	it("never splits a batch that fits across statements", () => {
		const batch = (owner: string) => ({
			owner,
			ndjson: Arr.join(
				Array.from({ length: 8 }, (_, i) => line(i, 10_000)),
				"\n",
			),
		})
		const statements = buildBatchedInsertStatements("logs", Arr.map(["a", "b", "c"], batch))
		expect(statements.length).toBeGreaterThan(1)
		const owners = Arr.flatMap(statements, (statement) => Arr.map(statement.parts, (part) => part.owner))
		expect(owners).toEqual(["a", "b", "c"])
		for (const statement of statements)
			expect(Buffer.byteLength(statement.sql, "utf8")).toBeLessThan(256 * 1024)
	})

	it("splits a batch over the budget into statements of its own", () => {
		const big = Arr.join(
			Array.from({ length: 50 }, (_, i) => line(i, 10_000)),
			"\n",
		)
		const statements = buildBatchedInsertStatements("logs", [
			{ owner: "small", ndjson: line(1) },
			{ owner: "big", ndjson: big },
			{ owner: "after", ndjson: line(2) },
		])
		expect(Arr.map(statements, (statement) => Arr.map(statement.parts, (part) => part.owner))).toEqual([
			["small"],
			...Arr.map(buildInsertStatements("logs", big), () => ["big"]),
			["after"],
		])
		expect(Arr.reduce(statements, 0, (n, statement) => n + statement.rowCount)).toBe(52)
	})
})
