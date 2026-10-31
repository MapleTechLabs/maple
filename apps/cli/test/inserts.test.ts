import { describe, expect, it } from "vitest"
import { buildBatchedInsertStatements, buildInsertSql, buildInsertStatements } from "../src/server/inserts"

const line = (i: number, pad = 0) => JSON.stringify({ body: `row-${i}${"x".repeat(pad)}` })

describe("buildInsertStatements", () => {
	it("emits a single statement for a small batch, identical to buildInsertSql", () => {
		const ndjson = [line(1), line(2), line(3)].join("\n")
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
		const statements = buildInsertStatements("logs", rows.join("\n"))
		expect(statements.length).toBeGreaterThan(1)
		expect(statements.reduce((n, s) => n + s.rowCount, 0)).toBe(50)
		for (const statement of statements) {
			expect(Buffer.byteLength(statement.sql, "utf8")).toBeLessThan(256 * 1024)
		}
	})

	it("splits only on line boundaries — concatenated payloads round-trip", () => {
		const rows = Array.from({ length: 50 }, (_, i) => line(i, 10_000))
		const statements = buildInsertStatements("logs", rows.join("\n"))
		const payloads = statements.map((s) => {
			const start = s.sql.lastIndexOf(", '") + 3
			return s.sql.slice(start, -2)
		})
		expect(payloads.join("\n")).toBe(rows.join("\n"))
	})

	it("passes a single oversized line through as its own statement", () => {
		const huge = line(0, 300_000)
		const statements = buildInsertStatements("logs", [line(1), huge, line(2)].join("\n"))
		expect(statements.map((s) => s.rowCount)).toEqual([1, 1, 1])
		expect(statements[1]?.sql).toContain("x".repeat(300_000))
	})

	it("budgets on escaped bytes, not raw bytes", () => {
		// Each backslash escapes to two characters; 60 rows of ~3.4KB raw escape
		// to ~6.7KB each (~400KB total), forcing at least a three-way split.
		const rows = Array.from({ length: 60 }, () => JSON.stringify({ body: "\\".repeat(3_333) }))
		const statements = buildInsertStatements("logs", rows.join("\n"))
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
			{ owner: "b", ndjson: [line(2), line(3)].join("\n") },
		])
		expect(statements).toHaveLength(1)
		expect(statements[0]?.sql).toBe(buildInsertSql("logs", [line(1), line(2), line(3)].join("\n")))
		expect(statements[0]?.parts).toEqual([
			{ owner: "a", rowCount: 1 },
			{ owner: "b", rowCount: 2 },
		])
	})

	it("never splits a batch that fits across statements", () => {
		const batch = (owner: string) => ({
			owner,
			ndjson: Array.from({ length: 8 }, (_, i) => line(i, 10_000)).join("\n"),
		})
		const statements = buildBatchedInsertStatements("logs", ["a", "b", "c"].map(batch))
		expect(statements.length).toBeGreaterThan(1)
		const owners = statements.flatMap((statement) => statement.parts.map((part) => part.owner))
		expect(owners).toEqual(["a", "b", "c"])
		for (const statement of statements)
			expect(Buffer.byteLength(statement.sql, "utf8")).toBeLessThan(256 * 1024)
	})

	it("splits a batch over the budget into statements of its own", () => {
		const big = Array.from({ length: 50 }, (_, i) => line(i, 10_000)).join("\n")
		const statements = buildBatchedInsertStatements("logs", [
			{ owner: "small", ndjson: line(1) },
			{ owner: "big", ndjson: big },
			{ owner: "after", ndjson: line(2) },
		])
		expect(statements.map((statement) => statement.parts.map((part) => part.owner))).toEqual([
			["small"],
			...buildInsertStatements("logs", big).map(() => ["big"]),
			["after"],
		])
		expect(statements.reduce((n, statement) => n + statement.rowCount, 0)).toBe(52)
	})
})
