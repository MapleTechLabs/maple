import { describe, expect, it } from "vitest"
import { rawSqlIssue } from "@maple/domain/raw-sql"
import { fixFromError, fixOrgFilterOr, guardSelectStar } from "./sql-fixes"

const unknown = (name: string) => `Unknown expression or function identifier \`${name}\` in scope SELECT`
const SYNTAX = "DB::Exception: Syntax error: failed at position 96 (FROM)"
const NO_SUPERTYPE =
	"There is no supertype for types String, UInt16 because some of them are String/FixedString/Enum and some of them are not"

// Each SQL is a production run_sql failure (MCP self-traces, 2026-10-31..11-07), trimmed.
describe("fixFromError", () => {
	it("reads trace_list_mv's extracted columns instead of attribute maps", () => {
		const fix = fixFromError(
			"SELECT SpanAttributes['http.route'] AS route, SpanAttributes['http.request.method'] m, count() AS n FROM trace_list_mv " +
				"WHERE $__orgFilter AND ServiceName='subscriptions-api' GROUP BY route, m",
			unknown("SpanAttributes"),
		)
		expect(fix?.sql).toBe(
			"SELECT HttpRoute AS route, HttpMethod m, count() AS n FROM trace_list_mv " +
				"WHERE $__orgFilter AND ServiceName='subscriptions-api' GROUP BY route, m",
		)
		expect(fix?.rewrites).toEqual([
			{ from: "SpanAttributes['http.route']", to: "HttpRoute" },
			{ from: "SpanAttributes['http.request.method']", to: "HttpMethod" },
		])
	})

	it("leaves a map read alone when one key has no column", () => {
		expect(
			fixFromError(
				"SELECT SpanAttributes['http.route'], SpanAttributes['peer.service'] FROM trace_list_mv WHERE $__orgFilter",
				unknown("SpanAttributes"),
			),
		).toBeUndefined()
	})

	it("drops the root-span filter trace_list_mv cannot have", () => {
		const fix = fixFromError(
			"SELECT ServiceName, count() AS n FROM trace_list_mv WHERE $__orgFilter AND ServiceName = 'api' AND ParentSpanId = '' GROUP BY ServiceName",
			unknown("ParentSpanId"),
		)
		expect(fix?.sql).toBe(
			"SELECT ServiceName, count() AS n FROM trace_list_mv WHERE $__orgFilter AND ServiceName = 'api' AND 1 = 1 GROUP BY ServiceName",
		)
	})

	it("keeps ParentSpanId on trace_list_mv when it is selected, not filtered", () => {
		expect(
			fixFromError(
				"SELECT ParentSpanId FROM trace_list_mv WHERE $__orgFilter",
				unknown("ParentSpanId"),
			),
		).toBeUndefined()
	})

	it.each([
		[
			"SELECT ServiceName, count() n, any(substring(Body,1,200)) sample FROM logs WHERE $__orgFilter",
			"SELECT ServiceName, count() n, any(substring(Body,1,200)) AS `sample` FROM logs WHERE $__orgFilter",
		],
		[
			"SELECT mapKeys(ResourceAttributes) k, any(ResourceAttributes) sample, count() FROM session_replays WHERE $__orgFilter",
			"SELECT mapKeys(ResourceAttributes) k, any(ResourceAttributes) AS `sample`, count() FROM session_replays WHERE $__orgFilter",
		],
		[
			"SELECT multiIf(SpanName != 'x', '-', 'home') where, count() n FROM traces WHERE $__orgFilter",
			"SELECT multiIf(SpanName != 'x', '-', 'home') AS `where`, count() n FROM traces WHERE $__orgFilter",
		],
	])("quotes a keyword used as an alias: %s", (sql, expected) => {
		expect(fixFromError(sql, SYNTAX)?.sql).toBe(expected)
	})

	it("does not touch a WHERE clause after a table", () => {
		expect(fixFromError("SELECT count() FROM traces where $__orgFilter", SYNTAX)).toBeUndefined()
	})

	it("quotes a bare map key the warehouse reports as an unknown column, not renaming it", () => {
		expect(
			fixFromError(
				"SELECT SpanAttributes[http.route] AS route FROM traces WHERE $__orgFilter",
				unknown("http.route"),
			)?.sql,
		).toBe("SELECT SpanAttributes['http.route'] AS route FROM traces WHERE $__orgFilter")
	})

	it("does not alias a keyword after a table name", () => {
		expect(fixFromError("SELECT 1 FROM traces FINAL, logs WHERE $__orgFilter", SYNTAX)).toBeUndefined()
	})

	it("quotes a dotted map key written bare", () => {
		expect(
			fixFromError(
				"SELECT SpanAttributes[http.route] AS route FROM traces WHERE $__orgFilter",
				`${SYNTAX}: http.route`,
			)?.sql,
		).toBe("SELECT SpanAttributes['http.route'] AS route FROM traces WHERE $__orgFilter")
	})

	it.each([
		[
			"SELECT count() FROM trace_list_mv WHERE $__orgFilter AND HttpStatusCode >= 500",
			"SELECT count() FROM trace_list_mv WHERE $__orgFilter AND toFloat64OrNull(HttpStatusCode) >= 500",
		],
		[
			"SELECT count() FROM traces WHERE $__orgFilter AND SpanAttributes['http.response.status_code'] BETWEEN 500 AND 599",
			"SELECT count() FROM traces WHERE $__orgFilter AND toFloat64OrNull(SpanAttributes['http.response.status_code']) BETWEEN 500 AND 599",
		],
	])("reads a String compared to a number as a number: %s", (sql, expected) => {
		expect(fixFromError(sql, NO_SUPERTYPE)?.sql).toBe(expected)
	})

	it("does not wrap a number column or a string inside a literal", () => {
		expect(
			fixFromError(
				"SELECT count() FROM traces WHERE $__orgFilter AND Duration > 5 AND Body = 'HttpStatusCode >= 500'",
				NO_SUPERTYPE,
			),
		).toBeUndefined()
	})

	it.each([
		[
			"SELECT ServiceName, sum(Count) c FROM service_operations_hourly WHERE $__orgFilter GROUP BY ServiceName",
			"Count",
			"SpanCount",
		],
		[
			"SELECT toStartOfHour(Timestamp) h FROM service_operations_minutely WHERE $__orgFilter AND $__timeFilter(Timestamp)",
			"Timestamp",
			"Minute",
		],
		["SELECT max(Timestamp) FROM metrics_gauge WHERE $__orgFilter", "Timestamp", "TimeUnix"],
		[
			"SELECT substring(StackTrace, 1, 200) FROM error_events WHERE $__orgFilter",
			"StackTrace",
			"ExceptionStacktrace",
		],
	])("renames an invented rollup column: %s", (sql, from, to) => {
		const fix = fixFromError(sql, unknown(from))
		expect(fix?.rewrites).toEqual([{ from, to }])
		expect(fix?.sql).not.toMatch(new RegExp(`\\b${from}\\b`))
	})

	it("reads DeploymentEnv on traces from the resource attributes", () => {
		expect(
			fixFromError(
				"SELECT DeploymentEnv, count() FROM traces WHERE $__orgFilter GROUP BY DeploymentEnv",
				unknown("DeploymentEnv"),
			)?.sql,
		).toContain("ResourceAttributes['deployment.environment.name']")
	})
})

describe("guardSelectStar", () => {
	it("leaves aggregate states out of SELECT * on a rollup", () => {
		const fix = guardSelectStar("SELECT * FROM service_operations_hourly WHERE $__orgFilter LIMIT 5")
		expect(fix?.sql).toBe(
			"SELECT * EXCEPT (DurationQuantiles) FROM service_operations_hourly WHERE $__orgFilter LIMIT 5",
		)
	})

	it.each([
		"SELECT * FROM traces WHERE $__orgFilter LIMIT 5",
		"SELECT ServiceName FROM service_operations_hourly WHERE $__orgFilter",
		"SELECT * FROM service_operations_hourly s JOIN service_overview_hourly o USING ServiceName WHERE $__orgFilter(s)",
	])("leaves other queries alone: %s", (sql) => {
		expect(guardSelectStar(sql)).toBeUndefined()
	})
})

describe("fixOrgFilterOr", () => {
	it.each([
		[
			"SELECT count() FROM logs WHERE $__orgFilter AND SeverityText = 'ERROR' OR Body ILIKE '%error%' LIMIT 5",
			"SELECT count() FROM logs WHERE $__orgFilter AND (SeverityText = 'ERROR' OR Body ILIKE '%error%') LIMIT 5",
		],
		[
			"SELECT count() FROM logs WHERE a = 1 OR b = 2 AND $__orgFilter GROUP BY x",
			"SELECT count() FROM logs WHERE $__orgFilter AND (a = 1 OR b = 2) GROUP BY x",
		],
		[
			"SELECT count() FROM logs WHERE $__orgFilter AND a = 1 OR b = 2;",
			"SELECT count() FROM logs WHERE $__orgFilter AND (a = 1 OR b = 2);",
		],
		[
			"SELECT count() FROM traces WHERE $__orgFilter AND a = 1 OR ($__orgFilter AND b IN (SELECT x FROM logs WHERE $__orgFilter AND c = 1 OR d = 2)) GROUP BY y",
			"SELECT count() FROM traces WHERE $__orgFilter AND (a = 1 OR (b IN (SELECT x FROM logs WHERE $__orgFilter AND (c = 1 OR d = 2)))) GROUP BY y",
		],
	])("takes the filter out of the OR: %s", (sql, expected) => {
		const fixed = fixOrgFilterOr(sql)?.sql
		expect(fixed).toBe(expected)
		expect(rawSqlIssue(sql)?.code).toBe("InvalidMacro")
		expect(rawSqlIssue(fixed ?? "")).toBeNull()
	})

	it.each([
		[
			"SELECT count() FROM logs WHERE $__orgFilter OR a = 1",
			"SELECT count() FROM logs WHERE $__orgFilter AND (true OR a = 1)",
		],
		[
			"SELECT count() FROM logs WHERE a = 1 AND ($__orgFilter OR b = 2)",
			"SELECT count() FROM logs WHERE $__orgFilter AND (a = 1 AND (true OR b = 2))",
		],
		[
			"SELECT count() FROM logs WHERE NOT $__orgFilter",
			"SELECT count() FROM logs WHERE $__orgFilter AND (NOT true)",
		],
	])("never reads outside the org, whatever the clause: %s", (sql, expected) => {
		const fixed = fixOrgFilterOr(sql)?.sql
		expect(fixed).toBe(expected)
		expect(rawSqlIssue(fixed ?? "")).toBeNull()
	})

	it.each([
		[
			"SELECT count() FROM logs WHERE a = 1 OR NOT $__orgFilter AND b = 2",
			"SELECT count() FROM logs WHERE $__orgFilter AND (a = 1 OR NOT true AND b = 2)",
		],
		[
			"SELECT count() FROM logs WHERE $__orgFilter AND a = 1 OR b = 2 -- note\nLIMIT 5",
			"SELECT count() FROM logs WHERE $__orgFilter AND (a = 1 OR b = 2) -- note\nLIMIT 5",
		],
	])("keeps precedence and comments intact: %s", (sql, expected) => {
		expect(fixOrgFilterOr(sql)?.sql).toBe(expected)
		expect(rawSqlIssue(expected)).toBeNull()
	})

	it("leaves a clause whose filters name different tables", () => {
		expect(
			fixOrgFilterOr(
				"SELECT 1 FROM traces t JOIN logs l ON t.TraceId = l.TraceId WHERE $__orgFilter(t) OR $__orgFilter(l)",
			),
		).toBeUndefined()
	})
})
