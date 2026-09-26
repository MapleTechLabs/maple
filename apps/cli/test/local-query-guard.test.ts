import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { Result } from "effect"
import { Chdb, ChdbClosedError } from "../src/server/chdb"
import { countArrayRows, prepareLocalQuery, READ_ONLY_REJECTION_PREFIX } from "../src/server/query-guard"
import { __testables } from "../src/server/serve"

// Needs a real libchdb; skipped where none is installed.
const libchdbAvailable =
	process.env.MAPLE_LIBCHDB !== undefined ||
	existsSync(join(homedir(), ".maple", "bin", "libchdb.so")) ||
	existsSync(join(homedir(), ".maple", "bin", "libchdb.dylib"))

/** The engine's canonical form, as `formatQuerySingleLine` would print it. */
const engine = (canonical: string) => ({ query: () => canonical })

const rejection = (sql: string, canonical: string, allowWrites = false) => {
	const prepared = prepareLocalQuery(engine(canonical), sql, { allowWrites })
	return Result.isFailure(prepared) ? prepared.failure.message : undefined
}

describe("read-only statement preparation", () => {
	test("refuses writes, client-side file output and the file() function", () => {
		expect(rejection("INSERT INTO t SELECT 1", "INSERT INTO t SELECT 1")).toMatch(/only SELECT/)
		expect(rejection("SELECT 1 INTO OUTFILE 'x'", "SELECT 1 INTO OUTFILE 'x' FORMAT TSV")).toBe(
			"INTO OUTFILE is not allowed",
		)
		expect(rejection("SELECT file('/etc/hosts')", "SELECT file('/etc/hosts')")).toBe(
			"function file is not allowed",
		)
		expect(rejection("SELECT `file`('/x')", "SELECT `file`('/x')")).toBe("function file is not allowed")
		expect(rejection("EXPLAIN INSERT", "EXPLAIN INSERT INTO t SELECT 1")).toMatch(/EXPLAIN/)
		expect(rejection("DESC url(...)", "DESCRIBE TABLE url('http://h/x', 'CSVWithNames')")).toMatch(
			/DESCRIBE only accepts a table name/,
		)
		expect(rejection("SELECT 1 SETTINGS readonly = 0", "SELECT 1 SETTINGS readonly = 0")).toBe(
			"setting readonly is not allowed",
		)
		expect(rejection("SELECT '\0'", "SELECT 1")).toBe("NUL bytes are not allowed")
	})

	test("maps a multi-statement body to a read-only rejection", () => {
		const prepared = prepareLocalQuery(
			{
				query: () => {
					throw new Error(
						"Code: 62. Syntax error (Multi-statements are not allowed): failed at position 9",
					)
				},
			},
			"SELECT 1; SELECT 2",
			{ allowWrites: false },
		)
		expect(Result.isFailure(prepared) && prepared.failure._tag).toBe("@maple/cli/ReadOnlyQueryRejected")
	})

	test("does not mistake string contents for clauses", () => {
		const canonical = "SELECT 'INTO OUTFILE', 'file(x)' AS `a b` FROM t"
		const prepared = prepareLocalQuery(engine(canonical), canonical, { allowWrites: false })
		expect(Result.isSuccess(prepared)).toBe(true)
	})

	test("moves the query's own settings under the caps and ends with readonly", () => {
		const canonical = "SELECT 1 SETTINGS max_threads = 2, max_execution_time = 90 FORMAT JSON"
		const prepared = prepareLocalQuery(engine(canonical), canonical, { allowWrites: false })
		if (Result.isFailure(prepared)) throw prepared.failure
		expect(prepared.success.kind).toBe("read")
		expect(prepared.success.sql).toStartWith("SELECT 1\nFORMAT JSONEachRow\nSETTINGS ")
		// A client can lower a ceiling but never raise it.
		expect(prepared.success.sql).toContain("max_execution_time = 30")
		expect(prepared.success.sql).toContain("max_threads = 2")
		expect(prepared.success.sql).toEndWith("output_format_json_array_of_rows = 1, readonly = 1")
	})

	test("lets the maintenance token run a single write statement", () => {
		const canonical = "INSERT INTO t SELECT 1"
		const prepared = prepareLocalQuery(engine(canonical), canonical, { allowWrites: true })
		expect(Result.isSuccess(prepared) && prepared.success).toEqual({ kind: "write", sql: canonical })
	})

	test("counts array-of-rows output", () => {
		const encode = (text: string) => new TextEncoder().encode(text)
		expect(countArrayRows(encode("[\n\n]\n"))).toBe(0)
		expect(countArrayRows(encode('[\n{"a":"x\\n{"}\n]\n'))).toBe(1)
		expect(countArrayRows(encode('[\n{"a":1},\n{"a":2}\n]\n'))).toBe(2)
	})
})

describe.skipIf(!libchdbAvailable)("read-only /local/query against the engine", () => {
	test("blocks filesystem access, multiple statements and writes; serves reads", async () => {
		const root = mkdtempSync(join(tmpdir(), "maple-query-guard-"))
		const db = Chdb.open({ dataDir: join(root, "data"), schemaSql: "SELECT 1", bootstrapSchema: false })
		try {
			db.exec("CREATE TABLE t (a UInt64) ENGINE = MergeTree ORDER BY a")
			db.exec("INSERT INTO t VALUES (1), (2)")
			const authority = { hasRetiredDays: () => false }
			const run = async (sql: string) => {
				const request = new Request("http://127.0.0.1/local/query", {
					method: "POST",
					body: JSON.stringify({ sql }),
				})
				const { response } = await __testables.handleQuery(db, authority as never, "token", request)
				return { status: response.status, body: await response.text() }
			}
			const outfile = join(root, "outfile.tsv")
			for (const attack of [
				"SELECT line FROM file('/etc/hosts', 'LineAsString', 'line String')",
				`SELECT 'x' INTO OUTFILE '${outfile}' FORMAT TSV`,
				"SELECT 1 AS a; SELECT 2 AS b",
				"INSERT INTO t SELECT 3",
			]) {
				const { status, body } = await run(attack)
				expect(status).toBe(400)
				expect(body).toStartWith(READ_ONLY_REJECTION_PREFIX)
			}
			expect(existsSync(outfile)).toBe(false)
			// Table functions are refused by the engine's readonly mode.
			const url = await run("SELECT * FROM url('http://127.0.0.1:1/x', 'CSVWithNames')")
			expect(url.status).toBe(400)
			expect(url.body).toContain("READONLY")

			const read = await run("SELECT a FROM t ORDER BY a FORMAT JSON")
			expect(read.status).toBe(200)
			expect(JSON.parse(read.body)).toEqual([{ a: 1 }, { a: 2 }])
			expect(JSON.parse((await run("SELECT a FROM t WHERE a > 5")).body)).toEqual([])

			// A result cap failing mid-stream must not leak rows into the next reply.
			const capped = await run("SELECT number FROM numbers(300000) SETTINGS max_result_rows = 100000")
			expect(capped.status).toBe(400)
			expect(JSON.parse((await run("SELECT count() AS c FROM t")).body)).toEqual([{ c: 2 }])
		} finally {
			db.close()
			rmSync(root, { recursive: true, force: true })
		}
		expect(() => db.query("SELECT 1")).toThrow(ChdbClosedError)
	})
})
