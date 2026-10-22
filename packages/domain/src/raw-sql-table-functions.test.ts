import { describe, expect, it } from "vitest"
import { rawSqlIssue } from "./raw-sql"

describe("rawSqlIssue table sources", () => {
	it.each([
		// ClickHouse lexes Unicode double quotes as a quoted identifier.
		"SELECT * FROM “file”('/x', LineAsString) WHERE $__orgFilter",
		"SELECT * FROM traces WHERE $__orgFilter AND SpanId IN (SELECT * FROM “url”('http://x/'))",
	])("rejects Unicode-quoted names: %s", (sql) => {
		expect(rawSqlIssue(sql)).not.toBeNull()
	})

	it.each([
		"SELECT * FROM traces WHERE $__orgFilter AND SpanId IN (SELECT * FROM loop('d', 't'))",
		"SELECT * FROM traces t, loop('d', 't') x WHERE $__orgFilter(t)",
		"SELECT * FROM traces t JOIN generateRandom('a UInt8') g ON 1 = 1 WHERE $__orgFilter(t)",
		"SELECT * FROM traces t, numbers(1) n, primes(2) p WHERE $__orgFilter(t)",
		"SELECT * FROM traces t LEFT JOIN timeSeriesData('d', 't') s ON 1 = 1 WHERE $__orgFilter(t)",
		"SELECT * FROM traces WHERE $__orgFilter AND SpanId IN (SELECT * FROM view(SELECT * FROM loop('d', 't')))",
	])("rejects table functions outside the allow list: %s", (sql) => {
		expect(rawSqlIssue(sql)?.code).toBe("DisallowedFunction")
	})

	it.each([
		"SELECT * FROM url/**/('http://x/') WHERE $__orgFilter",
		"SELECT * FROM url -- c\n('http://x/') WHERE $__orgFilter",
		"SELECT * FROM url\t\n('http://x/') WHERE $__orgFilter",
		"SELECT * FROM `\\x75rl`('http://x/') WHERE $__orgFilter",
		"SELECT * FROM `u``rl`('http://x/') WHERE $__orgFilter",
		'SELECT * FROM "fi\\"le"(\'/x\') WHERE $__orgFilter',
		"SELECT * FROM default.url('http://x/') WHERE $__orgFilter",
	])("rejects a blocked function however it is spelled: %s", (sql) => {
		expect(rawSqlIssue(sql)?.code).toBe("DisallowedFunction")
	})

	it.each([
		// Doubled quotes inside a literal or quoted identifier do not end it.
		"SELECT '' AS e FROM url('http://x/', CSV, 'a String') WHERE $__orgFilter",
		"SELECT 'it''s' AS e FROM url('http://x/') WHERE $__orgFilter",
		"SELECT 'a\\\\' AS e FROM url('http://x/') WHERE $__orgFilter",
		"SELECT `a``b` FROM url('http://x/') WHERE $__orgFilter",
		'SELECT "a""b" FROM url(\'http://x/\') WHERE $__orgFilter',
		// Modifiers and join constraints do not end the FROM list.
		"SELECT * FROM traces FINAL, url('http://x/') u WHERE $__orgFilter",
		"SELECT * FROM traces SAMPLE 0.1, url('http://x/') u WHERE $__orgFilter",
		"SELECT * FROM traces t JOIN logs l ON 1 = 1, url('http://x/') u WHERE $__orgFilter(t)",
		"SELECT * FROM traces t JOIN logs l USING (TraceId), url('http://x/') u WHERE $__orgFilter(t)",
		// Other table positions.
		"SELECT * FROM traces WHERE $__orgFilter AND SpanId IN (FROM url('http://x/') SELECT *)",
		"SELECT * FROM (url('http://x/')) WHERE $__orgFilter",
		"SELECT * FROM traces WHERE $__orgFilter AND SpanId IN url('http://x/')",
		// A reader name is refused in any position.
		"SELECT file('/x') AS f FROM traces WHERE $__orgFilter",
		"SELECT * FROM traces WHERE $__orgFilter AND SpanId = (SELECT 1 FROM t WHERE 1 = url('http://x/'))",
		// A subquery in the FROM list must not end that list.
		"SELECT * FROM (SELECT 1 FROM traces) a, zeros(10) WHERE $__orgFilter",
	])("rejects table functions the walker must not miss: %s", (sql) => {
		expect(rawSqlIssue(sql)?.code).toBe("DisallowedFunction")
	})

	it.each([
		"SELECT number FROM numbers(10) WHERE $__orgFilter",
		"SELECT * FROM traces FINAL WHERE $__orgFilter",
		"SELECT 'it''s', `a``b` AS c FROM traces WHERE $__orgFilter",
		"SELECT * FROM traces t JOIN logs l USING (TraceId) WHERE $__orgFilter(t)",
		"SELECT * FROM traces WHERE $__orgFilter AND SpanId IN (SELECT SpanId FROM logs)",
		"SELECT * FROM traces WHERE $__orgFilter AND SpanId IN ('a', 'b')",
		"SELECT * FROM traces WHERE $__orgFilter AND SpanId IN tuple('a', 'b')",
		"SELECT * FROM traces t JOIN numbers(3) n ON 1 = 1 WHERE $__orgFilter(t)",
		"SELECT * FROM generateSeries(1, 3) WHERE $__orgFilter",
		"SELECT URLHash(Url) AS h, file FROM traces WHERE $__orgFilter",
		"SELECT 'url(' AS a, 'it’s “ok”' AS b FROM traces WHERE $__orgFilter -- “note”",
		"SELECT EXTRACT(DAY FROM toDateTime(Timestamp)) AS d FROM traces WHERE $__orgFilter",
		"SELECT trim(BOTH ' ' FROM lower(SpanName)) AS n FROM traces WHERE $__orgFilter",
		"SELECT x FROM traces ARRAY JOIN splitByChar(',', SpanName) AS x WHERE $__orgFilter",
		"SELECT * FROM traces t, logs l WHERE $__orgFilter(t) AND t.TraceId = l.TraceId",
		"SELECT * FROM traces WHERE $__orgFilter AND SpanId IN (SELECT SpanId FROM logs WHERE lower(Body) LIKE '%x%')",
		"WITH c AS (SELECT count() AS n FROM traces WHERE $__orgFilter) SELECT n FROM c",
		"SELECT * FROM (SELECT (Timestamp) AS t FROM traces WHERE $__orgFilter)",
		"SELECT * FROM traces t JOIN (SELECT (1) AS a) s ON 1 = 1 WHERE $__orgFilter(t)",
	])("accepts legitimate queries: %s", (sql) => {
		expect(rawSqlIssue(sql)).toBeNull()
	})
})
