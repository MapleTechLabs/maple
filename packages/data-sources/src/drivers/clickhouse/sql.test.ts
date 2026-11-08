import { describe, expect, it } from "vitest"
import { clickHouseSqlIssue, stripTerminal } from "./sql"
import { expandMacros, utcLiteral } from "./macros"

const window = {
	startMs: Date.UTC(2026, 10, 1, 0, 0, 0),
	endMs: Date.UTC(2026, 10, 2, 0, 0, 0),
	granularitySeconds: 3600,
}

describe("clickHouseSqlIssue", () => {
	it("accepts a plain read, system tables included, without an org filter", () => {
		expect(
			clickHouseSqlIssue("SELECT count() FROM shop.payments WHERE $__timeFilter(created_at)"),
		).toBeNull()
		expect(clickHouseSqlIssue("SELECT name FROM system.tables")).toBeNull()
		expect(clickHouseSqlIssue("WITH t AS (SELECT 1 AS a) SELECT a FROM t;")).toBeNull()
	})

	it.each([
		["INSERT INTO shop.payments VALUES (1)", "'INSERT' is not allowed"],
		["ALTER TABLE shop.payments DELETE WHERE 1", "'ALTER' is not allowed"],
		["SELECT 1; DROP TABLE shop.payments", "one statement"],
		["SELECT * FROM shop.payments INTO OUTFILE 'x.csv'", "INTO OUTFILE"],
		["SELECT * FROM url('http://169.254.169.254/', CSV)", "Table function 'url'"],
		["SELECT * FROM s3('https://bucket/x.csv')", "Table function 's3'"],
		["SELECT 1 SETTINGS readonly = 0", "SETTINGS is managed by Maple"],
		["SHOW TABLES", "Send a SELECT query"],
		["SELECT $__orgFilter", "Unknown macro $__orgFilter"],
		["SELECT $__timeFilter(created_at OR 1)", "must be a column name"],
		["SELECT $__timeGroup", "takes a column"],
		["", "between 1 and"],
	])("refuses %s", (sql, message) => {
		expect(clickHouseSqlIssue(sql)).toContain(message)
	})

	it("ignores keywords inside literals and comments", () => {
		expect(clickHouseSqlIssue("SELECT 'DROP TABLE x' AS s -- DELETE everything")).toBeNull()
	})
})

describe("stripTerminal", () => {
	it("drops a trailing FORMAT and semicolon but keeps a FORMAT inside a literal", () => {
		expect(stripTerminal("SELECT 1 FORMAT JSON;")).toBe("SELECT 1")
		expect(stripTerminal("SELECT 1;  ")).toBe("SELECT 1")
		expect(stripTerminal("SELECT ' FORMAT JSON'")).toBe("SELECT ' FORMAT JSON'")
	})
})

describe("expandMacros", () => {
	it("leaves macro names inside string literals and comments as written", () => {
		const sql = "SELECT '$__from' AS label, $__interval_s AS s FROM t -- $__to\nWHERE $__timeFilter(ts)"
		const expanded = expandMacros(sql, window)
		expect(expanded).toContain("'$__from' AS label")
		expect(expanded).toContain("-- $__to")
		expect(expanded).not.toContain("$__interval_s")
		expect(expanded).not.toContain("$__timeFilter")
	})

	it("expands the time filter half-open with UTC DateTime64 literals", () => {
		expect(expandMacros("SELECT 1 FROM t WHERE $__timeFilter(created_at)", window)).toBe(
			"SELECT 1 FROM t WHERE (created_at >= toDateTime64('2026-11-01 00:00:00.000', 3, 'UTC') AND created_at < toDateTime64('2026-11-02 00:00:00.000', 3, 'UTC'))",
		)
	})

	it("buckets by the window granularity and substitutes plain macros", () => {
		expect(
			expandMacros(
				"SELECT $__timeGroup(ts) AS b, $__interval_s AS s, $__from AS f, $__to AS t",
				window,
			),
		).toBe(
			`SELECT toStartOfInterval(ts, INTERVAL 3600 SECOND) AS b, 3600 AS s, ${utcLiteral(window.startMs)} AS f, ${utcLiteral(window.endMs)} AS t`,
		)
	})

	it("expands every occurrence and copies `$` patterns in the SQL verbatim", () => {
		const sql =
			"SELECT '$& $` $\\'' AS s, $__timeGroup(a), $__timeGroup(b) WHERE $__timeFilter(a) AND $__timeFilter(b)"
		const expanded = expandMacros(sql, window)
		expect(expanded).toContain("'$& $` $\\''")
		expect(expanded).toContain(
			"toStartOfInterval(a, INTERVAL 3600 SECOND), toStartOfInterval(b, INTERVAL 3600 SECOND)",
		)
		expect(expanded).toContain("(b >= toDateTime64(")
		expect(expanded).not.toContain("$__")
	})

	it("never buckets below one second", () => {
		expect(expandMacros("$__interval_s", { ...window, granularitySeconds: 0.2 })).toBe("1")
	})
})
