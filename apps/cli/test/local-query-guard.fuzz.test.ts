import { afterAll, beforeAll, expect, test } from "bun:test"
import fc from "fast-check"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Chdb } from "@maple/local-server/chdb"
import { __testables } from "@maple/local-server/serve"
import { describeWithChdb } from "./libchdb-test-support"

// Whatever SQL a page on local.maple.dev sends, an anonymous /local/query must
// leave the store, the session settings, the filesystem and the network as it
// found them. The engine is the oracle: each generated statement runs for real.

let root = ""
let outDir = ""
let db: Chdb
let hits = 0
// A local file no response may ever contain. Fixed path: the generators embed it at import.
const secretPath = join(tmpdir(), `maple-query-guard-secret-${process.pid}.txt`)
const SECRET = `maple-secret-${crypto.randomUUID()}`
// Module scope: the generators below interpolate its port when they are built.
const listener = Bun.serve({
	port: 0,
	fetch: () => {
		hits++
		return new Response("a\n1\n")
	},
})

const run = async (sql: string) => {
	const request = new Request("http://127.0.0.1/local/query", {
		method: "POST",
		body: JSON.stringify({ sql }),
	})
	const authority = { hasRetiredDays: () => false }
	const { response } = await __testables.handleQuery(db, authority as never, "token", request)
	return { status: response.status, body: await response.text() }
}

/** Everything a statement could have changed, read through the trusted connection. */
const snapshot = () => ({
	tables: db.query(
		"SELECT database, name FROM system.tables WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') ORDER BY database, name",
	),
	rows: db.query(
		"SELECT (SELECT groupArray(a) FROM (SELECT a FROM t ORDER BY a)) AS t, (SELECT groupArray(x) FROM canary) AS canary",
	),
	settings: db.query("SELECT name, value FROM system.settings WHERE changed ORDER BY name"),
	currentDatabase: db.query("SELECT currentDatabase()"),
	files: (() => {
		try {
			return readdirSync(outDir)
		} catch {
			return []
		}
	})(),
})

const port = () => listener.port

const reads = () => [
	"SELECT 1",
	"SELECT a FROM t",
	"(SELECT a FROM t)",
	"WITH x AS (SELECT 1 AS v) SELECT v FROM x",
	"SHOW TABLES",
	"SHOW CREATE TABLE t",
	"DESCRIBE TABLE t",
	"EXISTS TABLE t",
	"SELECT * FROM numbers(3)",
	"SELECT 'DROP TABLE canary; INSERT INTO t'",
	"SELECT `file`",
]

const writes = () => [
	"INSERT INTO t SELECT 9",
	"INSERT INTO t VALUES (9)",
	"INSERT INTO FUNCTION file('" + join(outDir, "f.tsv") + "', 'TSV', 'a UInt8') SELECT 1",
	"DROP TABLE canary",
	"TRUNCATE TABLE canary",
	"ALTER TABLE canary DELETE WHERE 1",
	"ALTER TABLE canary UPDATE x = 0 WHERE 1",
	"DELETE FROM canary WHERE 1",
	"CREATE TABLE z (a UInt8) ENGINE = Memory",
	"CREATE VIEW v AS SELECT 1",
	"CREATE TEMPORARY TABLE tmp (a UInt8)",
	"RENAME TABLE canary TO c2",
	"EXCHANGE TABLES t AND canary",
	"DETACH TABLE canary",
	"OPTIMIZE TABLE t FINAL",
	"SET readonly = 0",
	"SET max_result_rows = 0",
	"USE system",
	"SYSTEM DROP MARK CACHE",
	"KILL QUERY WHERE 1",
	"GRANT ALL ON *.* TO default",
	"BACKUP TABLE t TO File('b')",
]

const sideEffects = () => [
	`SELECT * FROM file('${secretPath}', 'LineAsString')`,
	`SELECT file('${secretPath}')`,
	`SELECT * FROM file('${secretPath}', 'LineAsString', 'line String')`,
	`SELECT * FROM url('http://127.0.0.1:${port()}/u', 'CSVWithNames')`,
	`SELECT * FROM s3('http://127.0.0.1:${port()}/b/k', 'CSVWithNames')`,
	`SELECT * FROM remote('127.0.0.1:${port()}', system.one)`,
	`SELECT 1 INTO OUTFILE '${join(outDir, "o.tsv")}'`,
	"SELECT * FROM executable('x.sh', 'TSV', 'a String')",
	`SELECT * FROM urlCluster('default', 'http://127.0.0.1:${port()}/c', 'CSVWithNames')`,
	"SELECT catboostEvaluate('/x', 1)",
	"SELECT * FROM input('a String')",
]

const suffixes = () => [
	" SETTINGS readonly = 0",
	" SETTINGS readonly = 1, readonly = 0",
	" SETTINGS max_result_rows = 0",
	" SETTINGS allow_ddl = 1",
	" FORMAT TSV",
	" FORMAT JSON SETTINGS readonly = 0",
	` INTO OUTFILE '${join(outDir, "s.tsv")}'`,
	" -- trailing",
	" /* SETTINGS readonly = 0 */",
]

const atom = fc.oneof(
	fc.constantFrom(...reads()),
	fc.constantFrom(...writes()),
	fc.constantFrom(...sideEffects()),
)

const statement: fc.Arbitrary<string> = fc.letrec<{ stmt: string }>((tie) => ({
	stmt: fc.oneof(
		{ depthSize: "small", withCrossShrink: true },
		atom,
		fc.tuple(tie("stmt"), fc.constantFrom(...suffixes())).map(([s, suffix]) => s + suffix),
		tie("stmt").map((s) => `SELECT * FROM (${s})`),
		tie("stmt").map((s) => `WITH (${s}) AS q SELECT 1`),
		tie("stmt").map((s) => `SELECT 1 WHERE 1 IN (${s})`),
		fc
			.tuple(
				fc.constantFrom(
					"EXPLAIN",
					"EXPLAIN SYNTAX",
					"EXPLAIN AST",
					"EXPLAIN PIPELINE",
					"EXPLAIN ESTIMATE",
					"EXPLAIN QUERY TREE",
				),
				tie("stmt"),
			)
			.map(([explain, s]) => `${explain} ${s}`),
		fc
			.tuple(tie("stmt"), fc.constantFrom(";", "; ", ";\n", " ;", "\n;\n", ";--\n"), tie("stmt"))
			.map(([a, sep, b]) => a + sep + b),
		tie("stmt").map((s) => `/* x */ ${s}`),
		tie("stmt").map((s) => s.toLowerCase()),
		tie("stmt").map((s) => s.replaceAll(" ", "\n\t")),
	),
})).stmt

describeWithChdb("read-only /local/query under generated SQL", () => {
	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "maple-query-guard-fuzz-"))
		outDir = join(root, "out")
		db = Chdb.open({ dataDir: join(root, "data"), schemaSql: "SELECT 1", bootstrapSchema: false })
		db.exec("CREATE TABLE t (a UInt64) ENGINE = MergeTree ORDER BY a")
		db.exec("INSERT INTO t VALUES (1), (2)")
		db.exec("CREATE TABLE canary (x UInt8) ENGINE = MergeTree ORDER BY x")
		db.exec("INSERT INTO canary VALUES (7)")
		writeFileSync(secretPath, `${SECRET}\n`)
	})

	afterAll(() => {
		db?.close()
		if (root !== "") rmSync(root, { recursive: true, force: true })
		rmSync(secretPath, { force: true })
	})

	test("never reads local files, nor changes the store, the session, the filesystem or the network", async () => {
		const before = snapshot()
		await fc.assert(
			fc.asyncProperty(statement, async (sql) => {
				const { status, body } = await run(sql)
				expect([200, 400]).toContain(status)
				expect(body).not.toContain(SECRET)
				expect(snapshot()).toEqual(before)
				expect(hits).toBe(0)
			}),
			{ numRuns: 400 },
		)
	}, 120_000)
})

afterAll(() => listener.stop(true))
