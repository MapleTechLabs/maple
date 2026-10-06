import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { isValidRawSql, rawAlertSampleCountWarning, RawSqlText, rawSqlIssue } from "./raw-sql"

const ok = "SELECT count() FROM logs WHERE $__orgFilter AND $__timeFilter(Timestamp)"

describe("rawSqlIssue", () => {
	it("accepts a well-formed query", () => {
		expect(rawSqlIssue(ok)).toBeNull()
		expect(rawSqlIssue(ok, { workload: "alert" })).toBeNull()
	})

	it("requires $__orgFilter", () => {
		expect(rawSqlIssue("SELECT 1 FROM logs")?.code).toBe("MissingOrgFilter")
	})

	// Same masking bug the org filter had: a macro in a comment expands to nothing,
	// so the alert would rescan all of history on every evaluation.
	it.each([
		"SELECT count() AS v FROM traces WHERE $__orgFilter -- $__timeFilter(Timestamp)",
		"SELECT count() AS v FROM traces WHERE $__orgFilter /* $__timeFilter(Timestamp) */",
		"SELECT count() AS v, '$__timeFilter(Timestamp)' AS x FROM traces WHERE $__orgFilter",
	])("rejects an alert whose $__timeFilter is not executable: %s", (sql) => {
		expect(rawSqlIssue(sql, { workload: "alert" })?.code).toBe("InvalidMacro")
	})

	it("requires $__timeFilter for alerts only", () => {
		const sql = "SELECT count() FROM logs WHERE $__orgFilter"
		expect(rawSqlIssue(sql)).toBeNull()
		expect(rawSqlIssue(sql, { workload: "alert" })?.code).toBe("InvalidMacro")
	})

	it("rejects an empty or oversized query", () => {
		expect(rawSqlIssue("")?.code).toBe("ResourceLimit")
		expect(rawSqlIssue(`SELECT '${"x".repeat(32_768)}' WHERE $__orgFilter`)?.code).toBe("ResourceLimit")
	})

	it("rejects a non-identifier macro argument", () => {
		const issue = rawSqlIssue("SELECT 1 WHERE $__orgFilter AND $__timeFilter(toDate(t))")
		expect(issue?.code).toBe("InvalidMacro")
		expect(issue?.message).toContain("column identifier")
	})

	it("rejects an unknown macro", () => {
		expect(rawSqlIssue("SELECT $__nope WHERE $__orgFilter")?.code).toBe("UnresolvedMacro")
	})

	it("rejects multiple statements but tolerates one trailing terminator", () => {
		expect(rawSqlIssue("SELECT 1 WHERE $__orgFilter; SELECT 2")?.code).toBe("MultipleStatements")
		expect(rawSqlIssue("SELECT 1 WHERE $__orgFilter;")).toBeNull()
	})

	it("ignores semicolons inside strings and comments", () => {
		expect(rawSqlIssue("SELECT ';' WHERE $__orgFilter -- ; here")).toBeNull()
	})

	it("rejects deny-listed statement keywords", () => {
		for (const keyword of ["INSERT", "DROP", "ALTER", "SYSTEM", "KILL"]) {
			expect(rawSqlIssue(`${keyword} something WHERE $__orgFilter`)?.code).toBe("DisallowedStatement")
		}
	})

	// `$__orgFilter` used to be checked with a raw `includes`, so a mention in a
	// comment satisfied the requirement while expanding to nothing — the tenant
	// predicate became opt-out for anyone who noticed.
	it.each([
		"SELECT 1 FROM traces WHERE 1=1 -- $__orgFilter",
		"SELECT 1 FROM traces /* $__orgFilter */ WHERE 1=1",
		"SELECT '$__orgFilter' AS x FROM traces",
	])("rejects $__orgFilter hidden from the query: %s", (sql) => {
		expect(rawSqlIssue(sql)?.code).toBe("MissingOrgFilter")
	})

	// Statement-shape checks say nothing about where a SELECT reads from, and a
	// table function makes the *server* fetch — per-org credentials never see it.
	it.each([
		"SELECT * FROM url('http://169.254.169.254/', JSONEachRow) WHERE $__orgFilter",
		"SELECT * FROM remote('10.0.0.1:9000', default.traces) WHERE $__orgFilter",
		"SELECT * FROM s3('https://x/y.parquet') WHERE $__orgFilter",
		"SELECT * FROM mysql('h:3306','d','t','u','p') WHERE $__orgFilter",
		"SELECT * FROM postgresql('h:5432','d','t','u','p') WHERE $__orgFilter",
		"SELECT * FROM file('/etc/passwd', LineAsString) WHERE $__orgFilter",
		// A subquery is the documented way past the org-filter requirement: the
		// outer query supplies OrgId while the inner one does the fetching.
		"SELECT OrgId FROM traces WHERE $__orgFilter AND SpanId IN (SELECT * FROM url('http://internal/'))",
		// Case and whitespace are not a bypass.
		"SELECT * FROM URL ('http://internal/') WHERE $__orgFilter",
		// Suffixed variants: an exact-name list matched `iceberg` but not
		// `icebergS3`, so every lake-format reader walked straight through.
		"SELECT * FROM icebergS3('https://x/y', 'k', 's') WHERE $__orgFilter",
		"SELECT * FROM icebergAzure('https://x/y') WHERE $__orgFilter",
		"SELECT * FROM deltaLakeS3('https://x/y') WHERE $__orgFilter",
		"SELECT * FROM deltaLakeAzure('https://x/y') WHERE $__orgFilter",
		"SELECT * FROM icebergS3Cluster('c', 'https://x/y') WHERE $__orgFilter",
		"SELECT * FROM s3Cluster('c', 'https://x/y.parquet') WHERE $__orgFilter",
		"SELECT * FROM executablePool('script', TSV, 'x UInt32') WHERE $__orgFilter",
	])("rejects network and filesystem table functions: %s", (sql) => {
		expect(rawSqlIssue(sql)?.code).toBe("DisallowedFunction")
	})

	// The check is anchored on the call form, so ordinary names survive.
	it.each([
		"SELECT urlHash(Url) AS h FROM traces WHERE $__orgFilter",
		"SELECT file FROM traces WHERE $__orgFilter",
		"SELECT domain(Url) AS d FROM traces WHERE $__orgFilter",
		"SELECT 'url(' AS literal FROM traces WHERE $__orgFilter",
		// Scalar functions sharing a prefix with a blocked name. These are why
		// `url`, `file` and `hive` are matched exactly rather than as prefixes.
		"SELECT URLHash(Url) AS h FROM traces WHERE $__orgFilter",
		"SELECT URLPathHierarchy(Url) AS p FROM traces WHERE $__orgFilter",
		"SELECT filesystemAvailable() AS free FROM traces WHERE $__orgFilter",
		"SELECT hiveHash(SpanName) AS h FROM traces WHERE $__orgFilter",
	])("does not mistake a column or unrelated function for a table function: %s", (sql) => {
		expect(rawSqlIssue(sql)).toBeNull()
	})

	it("rejects INTO OUTFILE", () => {
		expect(rawSqlIssue("SELECT 1 WHERE $__orgFilter INTO OUTFILE '/tmp/x'")?.message).toContain(
			"INTO OUTFILE",
		)
	})

	it("rejects a non-SELECT query", () => {
		expect(rawSqlIssue("EXPLAIN SELECT 1 WHERE $__orgFilter")?.code).toBe("DisallowedStatement")
	})

	it("accepts a leading WITH", () => {
		expect(rawSqlIssue("WITH x AS (SELECT 1) SELECT * FROM x WHERE $__orgFilter")).toBeNull()
	})

	it("rejects an author-supplied SETTINGS clause", () => {
		const issue = rawSqlIssue("SELECT 1 WHERE $__orgFilter SETTINGS max_execution_time=3000")
		expect(issue?.code).toBe("DisallowedStatement")
		expect(issue?.message).toContain("SETTINGS is managed by Maple")
	})

	it("accepts a trailing FORMAT — the driver owns the wire format", () => {
		expect(rawSqlIssue("SELECT 1 WHERE $__orgFilter FORMAT JSONEachRow")).toBeNull()
	})

	it("does not mistake a column named settings or format for a clause", () => {
		expect(rawSqlIssue("SELECT settings, format FROM t WHERE $__orgFilter")).toBeNull()
	})
})

describe("isValidRawSql", () => {
	it("mirrors rawSqlIssue", () => {
		expect(isValidRawSql(ok)).toBe(true)
		expect(isValidRawSql("SELECT 1")).toBe(false)
		expect(isValidRawSql("SELECT count() FROM logs WHERE $__orgFilter", "alert")).toBe(false)
	})
})

describe("RawSqlText", () => {
	const decode = Schema.decodeUnknownSync(RawSqlText)

	it("accepts a valid query", () => {
		expect(decode(ok)).toBe(ok)
	})

	it("surfaces the validator's own message", () => {
		expect(() => decode("SELECT 1")).toThrow(/\$__orgFilter/)
		expect(() => decode("SELECT 1 WHERE $__orgFilter SETTINGS max_threads=8")).toThrow(
			/SETTINGS is managed by Maple/,
		)
	})
})

describe("rawAlertSampleCountWarning", () => {
	const noSamples = "SELECT count() AS value FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp)"
	const withSamples =
		"SELECT countIf(StatusCode = 'Error') / count() AS value, count() AS samples FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp)"

	it("warns when a minimum above 1 would count rows", () => {
		expect(rawAlertSampleCountWarning(noSamples, 50)).toMatch(/counts returned rows/)
	})

	it("stays quiet when the query selects samples or the minimum is trivial", () => {
		expect(rawAlertSampleCountWarning(withSamples, 50)).toBeNull()
		expect(rawAlertSampleCountWarning(noSamples, 1)).toBeNull()
		expect(rawAlertSampleCountWarning(noSamples, 0)).toBeNull()
	})

	it("accepts a quoted alias and rejects one the engine would not read", () => {
		const quoted = (alias: string) =>
			`SELECT count() AS value, count() AS ${alias} FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp)`
		expect(rawAlertSampleCountWarning(quoted("`samples`"), 10)).toBeNull()
		expect(rawAlertSampleCountWarning(quoted('"samples"'), 10)).toBeNull()
		expect(rawAlertSampleCountWarning(quoted("Samples"), 10)).not.toBeNull()
		expect(rawAlertSampleCountWarning(quoted("samples_total"), 10)).not.toBeNull()
		expect(rawAlertSampleCountWarning(`${noSamples} AND t.samples > 0`, 10)).not.toBeNull()
	})

	it("ignores samples mentioned only in a comment or string", () => {
		expect(rawAlertSampleCountWarning(`${noSamples} -- samples`, 10)).not.toBeNull()
		expect(
			rawAlertSampleCountWarning(noSamples.replace("count()", "countIf(x = 'samples')"), 10),
		).not.toBeNull()
	})
})

describe("rawSqlIssue org filter placement", () => {
	it.each([
		"SELECT 1 FROM traces WHERE $__orgFilter AND SpanName = 'a' OR (ServiceName = 'b')",
		"SELECT 1 FROM traces WHERE a = 1 OR b = 2 AND $__orgFilter",
		"SELECT 1 FROM traces WHERE ($__orgFilter AND a = 1) OR b = 2",
		"SELECT 1 FROM traces WHERE NOT $__orgFilter",
		"SELECT 1 FROM traces WHERE not($__orgFilter)",
		"SELECT 1 FROM traces WHERE $__orgFilter OR 1 = 1 GROUP BY 1",
		"SELECT 1 FROM traces WHERE $__orgFilter AND toStartOfHour(Timestamp) > x OR Environment = 'prod'",
		"SELECT 1 FROM traces WHERE $__orgFilter AND (x = 1) OR y = 2",
	])("rejects an org filter an OR can bypass: %s", (sql) => {
		expect(rawSqlIssue(sql)?.code).toBe("InvalidMacro")
	})

	it.each([
		"SELECT a OR b FROM traces WHERE $__orgFilter AND (x = 1 OR y = 2) GROUP BY 1",
		"SELECT 1 FROM traces WHERE ($__orgFilter) AND x = 1",
		"SELECT 1 FROM traces WHERE $__orgFilter AND (x IN (SELECT x FROM logs WHERE $__orgFilter) OR y = 1)",
		"SELECT 1 FROM traces t JOIN logs l ON t.TraceId = l.TraceId AND $__orgFilter(l) WHERE $__orgFilter(t) AND (a OR b)",
		"SELECT 1 FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp) HAVING count() > 1 OR 1 = 1",
	])("accepts an org filter that is a top-level AND condition: %s", (sql) => {
		expect(rawSqlIssue(sql)).toBeNull()
	})

	it.each([
		"SELECT * FROM traces t CROSS JOIN (SELECT 'org_abc' AS OrgId) f WHERE $__orgFilter(f)",
		"WITH f AS (SELECT 'org_abc' AS OrgId) SELECT * FROM traces t, f WHERE $__orgFilter(f)",
		"WITH f AS (SELECT 'org_abc' AS OrgId) SELECT * FROM traces t JOIN f ON 1 = 1 WHERE $__orgFilter(f)",
		"SELECT * FROM traces t JOIN numbers(1) n ON 1 = 1 WHERE $__orgFilter(n)",
		"SELECT * FROM traces t WHERE $__orgFilter(x)",
	])("rejects an alias that is not a table read in FROM/JOIN: %s", (sql) => {
		expect(rawSqlIssue(sql)?.message).toContain("must name a table read in FROM or JOIN")
	})

	it.each([
		"SELECT 1 FROM traces AS t WHERE $__orgFilter(t)",
		"SELECT 1 FROM traces WHERE $__orgFilter(traces)",
		"SELECT 1 FROM maple.traces t FINAL WHERE $__orgFilter(t)",
		"SELECT 1 FROM traces t LEFT JOIN logs AS l ON t.TraceId = l.TraceId WHERE $__orgFilter(t) AND $__orgFilter(l)",
	])("accepts an alias bound to a table: %s", (sql) => {
		expect(rawSqlIssue(sql)).toBeNull()
	})

	it("rejects a non-identifier alias", () => {
		expect(rawSqlIssue("SELECT 1 FROM traces WHERE $__orgFilter(t OR 1)")?.code).toBe("InvalidMacro")
	})

	it("points system-table reads at the catalog", () => {
		expect(rawSqlIssue("SELECT name FROM system.columns WHERE $__orgFilter")?.message).toContain(
			"describe_warehouse_tables",
		)
	})
})

describe("rawSqlIssue org filter review follow-ups", () => {
	it.each([
		"SELECT 1 FROM traces WHERE coalesce($__orgFilter, 0) OR SpanName = 'x'",
		"SELECT 1 FROM traces WHERE if(SpanName = 'x', $__orgFilter, 1)",
		"SELECT 1 FROM traces WHERE multiIf(a = 1, $__orgFilter, 1)",
		"SELECT 1 FROM traces WHERE toUInt8($__orgFilter) AND x = 1",
	])("rejects an org filter wrapped in a function call: %s", (sql) => {
		expect(rawSqlIssue(sql)?.code).toBe("InvalidMacro")
	})

	it("still accepts an org filter scoped to an IN subquery", () => {
		expect(
			rawSqlIssue(
				"SELECT 1 FROM traces WHERE $__orgFilter AND x IN (SELECT x FROM logs WHERE $__orgFilter)",
			),
		).toBeNull()
	})

	it.each([
		"SELECT 1 FROM traces t, logs l WHERE $__orgFilter(t) AND $__orgFilter(l)",
		"SELECT 1 FROM traces AS t, default.logs AS l, metrics_sum m WHERE $__orgFilter(t) AND $__orgFilter(l) AND $__orgFilter(m)",
	])("binds aliases from a comma-separated FROM list: %s", (sql) => {
		expect(rawSqlIssue(sql)).toBeNull()
	})

	it.each([
		"SELECT 1 FROM traces t, (SELECT 1 AS OrgId) l WHERE $__orgFilter(t) AND $__orgFilter(l)",
		"SELECT 1 FROM traces t, numbers(10) l WHERE $__orgFilter(t) AND $__orgFilter(l)",
		"WITH c AS (SELECT 1 AS OrgId) SELECT 1 FROM traces t, c l WHERE $__orgFilter(t) AND $__orgFilter(l)",
	])("still rejects a comma item that is not a table: %s", (sql) => {
		expect(rawSqlIssue(sql)?.code).toBe("InvalidMacro")
	})
})
