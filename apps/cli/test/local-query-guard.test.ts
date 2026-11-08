import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Result } from "effect"
import { Chdb, ChdbClosedError } from "@maple/local-server/chdb"
import { describeWithChdb } from "./libchdb-test-support"
import {
	countArrayRows,
	prepareLocalQuery,
	READ_ONLY_REJECTION_PREFIX,
	ReadOnlyQueryRejected,
} from "@maple/local-server/query-guard"
import { __testables } from "@maple/local-server/serve"

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
		expect(rejection("DESC (SELECT 1)", "DESCRIBE TABLE (SELECT 1)")).toMatch(
			/DESCRIBE only accepts a table name/,
		)
		expect(rejection("SELECT 1 SETTINGS readonly = 0", "SELECT 1 SETTINGS readonly = 0")).toBe(
			"setting readonly is not allowed",
		)
		expect(rejection("SELECT '\0'", "SELECT 1")).toBe("NUL bytes are not allowed")
	})

	test("allows only in-memory generators as table functions and refuses readers anywhere", () => {
		for (const canonical of [
			"SELECT number FROM numbers(10)",
			"SELECT * FROM numbers(1, 3)",
			"SELECT * FROM generateSeries(1, 3)",
			"SELECT * FROM system.numbers LIMIT 1",
			"SELECT urlHash('x'), cityHash64(1) FROM t",
			"SELECT x, y FROM numbers(1) ARRAY JOIN [1, 2] AS x, arrayEnumerate([1, 2]) AS y",
		])
			expect(rejection(canonical, canonical)).toBeUndefined()
		for (const [canonical, name] of [
			["SELECT * FROM url('http://h/x', 'CSV')", "url"],
			["SELECT * FROM t JOIN s3('http://h/b/k', 'CSV') AS s ON 1", "s3"],
			["SELECT * FROM t, remoteSecure('h', system.one)", "remotesecure"],
			["SELECT * FROM values('a UInt8', 1)", "values"],
			["SELECT * FROM (SELECT * FROM merge('default', '.*'))", "merge"],
			["SELECT 1 WHERE 1 IN (SELECT * FROM `input`('a String'))", "input"],
			["EXPLAIN SELECT * FROM urlCluster('c', 'http://h/x')", "urlcluster"],
			["SELECT file('/etc/hosts')", "file"],
			["SELECT * FROM numbers(1) AS limit, filesystem('/') AS f", "filesystem"],
			["SELECT * FROM numbers(1) AS limit, values('a UInt8', 1) AS f", "values"],
			["SELECT * FROM t ARRAY JOIN [1] AS x, [2] AS y JOIN url('http://h/x') AS u ON 1", "url"],
			["SELECT * FROM t ARRAY JOIN [1] AS x JOIN s ON 1, values('a UInt8', 1) AS v", "values"],
		] as const)
			expect(rejection(canonical, canonical)).toBe(`function ${name} is not allowed`)
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

	test("hands the parser the query with every quote and backslash escaped", () => {
		const parsed: Array<string> = []
		prepareLocalQuery(
			{
				query: (wrapper) => {
					parsed.push(wrapper)
					return "SELECT 1"
				},
			},
			String.raw`SELECT 'a\'b\\'`,
			{ allowWrites: false },
		)
		expect(parsed[0]).toStartWith(String.raw`SELECT formatQuerySingleLine('SELECT \'a\\\'b\\\\\'')`)
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

	test("rejects an INSERT whose inline rows canonicalization would drop", () => {
		const sql = "INSERT INTO t VALUES (1, 'a')"
		const prepared = prepareLocalQuery(engine("INSERT INTO t FORMAT Values"), sql, { allowWrites: true })
		expect(Result.isFailure(prepared) && prepared.failure).toBeInstanceOf(ReadOnlyQueryRejected)
	})

	test("counts array-of-rows output", () => {
		const encode = (text: string) => new TextEncoder().encode(text)
		expect(countArrayRows(encode("[\n\n]\n"))).toBe(0)
		expect(countArrayRows(encode('[\n{"a":"x\\n{"}\n]\n'))).toBe(1)
		expect(countArrayRows(encode('[\n{"a":1},\n{"a":2}\n]\n'))).toBe(2)
	})
})

describeWithChdb("read-only /local/query against the engine", () => {
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
			const url = await run("SELECT * FROM url('http://127.0.0.1:1/x', 'CSVWithNames')")
			expect(url.status).toBe(400)
			expect(url.body).toBe(`${READ_ONLY_REJECTION_PREFIX}function url is not allowed`)
			// Settings are only taken from the trailing clause, where the caps hold.
			const inner = await run(
				"SELECT x FROM (SELECT getSetting('readonly') AS x SETTINGS readonly = 0)",
			)
			expect(inner.body).toBe(
				`${READ_ONLY_REJECTION_PREFIX}SETTINGS is only allowed once, at the end of the query`,
			)
			const union = await run("SELECT 1 AS a SETTINGS readonly = 0 UNION ALL SELECT 2 AS a")
			expect(union.status).toBe(400)
			const outer = await run("SELECT getSetting('readonly') AS r SETTINGS max_threads = 1")
			expect(JSON.parse(outer.body)).toEqual([{ r: 1 }])
			const generated = await run("SELECT count() AS c FROM generateSeries(1, 3)")
			expect(JSON.parse(generated.body)).toEqual([{ c: 3 }])

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
