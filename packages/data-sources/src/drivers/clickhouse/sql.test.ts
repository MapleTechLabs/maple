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
		["SELECT * FROM url\u200B('http://169.254.169.254/', CSV)", "plain ASCII"],
		["SELECT \u2018'\u2019 AS a, 1 SETTINGS readonly = 0, log_comment = \u2018'\u2019", "plain ASCII"],
		["SELECT $1$ ' $1$ AS a, 1 SETTINGS readonly = 0, log_comment = $1$ ' $1$", "Heredoc strings"],
		["SELECT 1 /* /* */ '*/ SETTINGS readonly = 0, log_comment = '", "Nested /* */ comments"],
		["SELECT 1 // '\n, (SELECT 2 SETTINGS readonly = 0) AS h -- '", "'//' comments"],
		[
			"SELECT 1 /*/*/ 'x */ ' != '*/ , (SELECT 2 SETTINGS readonly = 0) AS h -- '",
			"Nested /* */ comments",
		],
		["SELECT `getClientHTTPHe\\x61der`('Authorization')", "Backslashes are not supported"],
		["SELECT 1) UNION ALL (SELECT 2", "Unbalanced"],
		["SELECT getClientHTTPHeader('Authorization')", "getClientHTTPHeader"],
		["SELECT `getClientHTTPHeader` /* c */ ('Authorization')", "getClientHTTPHeader"],
		["SHOW TABLES", "Send a SELECT query"],
		["SELECT * FROM 'payments'", "A string literal cannot stand where a table goes"],
		["SELECT 1 FROM shop.orders AS o JOIN 'payments' AS p ON o.id = p.id", "A string literal cannot"],
		["SELECT 1 FROM shop.orders AS o, 'payments' AS p", "A string literal cannot"],
		["SELECT * FROM orders_$__interval_s", "$__interval_s is joined to a name or number"],
		["SELECT * FROM shop.pay$__interval_s", "$__interval_s is joined to a name or number"],
		["SELECT 1 AS x WHERE ts > 1$__from", "$__from is joined to a name or number"],
		["SELECT $__orgFilter", "Unknown macro $__orgFilter"],
		["SELECT $__timeFilter(created_at OR 1)", "must be a column name"],
		["SELECT $__timeGroup", "takes a column"],
		["", "between 1 and"],
	])("refuses %s", (sql, message) => {
		expect(clickHouseSqlIssue(sql)).toContain(message)
	})

	it("takes a string anywhere a value goes, and a macro set off from the names around it", () => {
		expect(
			clickHouseSqlIssue(
				"SELECT trim(BOTH ' ' FROM name) AS n, extract(day FROM '2026-11-01'::Date) FROM shop.orders WHERE kind IN ('a', 'b') ORDER BY n, 'x'",
			),
		).toBeNull()
		expect(
			clickHouseSqlIssue(
				"SELECT count()/$__interval_s AS rate, ($__from) AS f FROM shop.orders WHERE ts>=$__from AND $__timeFilter(ts)",
			),
		).toBeNull()
	})

	it("takes a string in an array or beside a quoted name that spells a keyword", () => {
		expect(
			clickHouseSqlIssue(
				"SELECT a.id FROM shop.orders AS a JOIN shop.kinds AS b ON a.id = b.id AND a.name IN ['x', 'o']",
			),
		).toBeNull()
		expect(clickHouseSqlIssue("SELECT `from`, 'x' FROM (SELECT 1 AS `from`)")).toBeNull()
		expect(clickHouseSqlIssue("SELECT `join`, 'x' FROM (SELECT 1 AS `join`)")).toBeNull()
	})

	it("still refuses a string as a table after an array or a quoted keyword name", () => {
		expect(
			clickHouseSqlIssue(
				"SELECT 1 FROM shop.orders AS o WHERE o.k IN ['a'] UNION ALL SELECT 1 FROM 'x'",
			),
		).toContain("A string literal cannot")
		expect(clickHouseSqlIssue("SELECT `from` FROM shop.orders AS `join`, 'x'")).toContain(
			"A string literal cannot",
		)
		expect(clickHouseSqlIssue("SELECT 1 FROM shop.orders AS `join`, foo(1)")).toContain(
			"Table function 'foo",
		)
	})

	it("ignores keywords inside literals and comments", () => {
		expect(clickHouseSqlIssue("SELECT 'DROP TABLE x' AS s -- DELETE everything")).toBeNull()
	})

	it("reads `$__` inside literals and comments as text, as expansion does", () => {
		expect(clickHouseSqlIssue("SELECT '$__orgFilter' AS s, '$__timeGroup' AS t -- $__nope")).toBeNull()
		expect(clickHouseSqlIssue("SELECT 1 /* $__timeFilter(a OR 1) */")).toBeNull()
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

	it("leaves a macro glued to a name alone, so expansion never completes a name", () => {
		expect(expandMacros("SELECT * FROM orders_$__interval_s", window)).toBe(
			"SELECT * FROM orders_$__interval_s",
		)
		expect(expandMacros("SELECT a$__from", window)).toBe("SELECT a$__from")
	})

	it("never buckets below one second", () => {
		expect(expandMacros("$__interval_s", { ...window, granularitySeconds: 0.2 })).toBe("1")
	})
})
