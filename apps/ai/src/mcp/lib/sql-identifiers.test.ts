import { describe, expect, it } from "vitest"
import { fixUnknownIdentifier } from "./sql-identifiers"

const unknown = (name: string) => `Unknown expression or function identifier \`${name}\` in scope SELECT`

describe("fixUnknownIdentifier", () => {
	it.each([
		[
			"SELECT service.name FROM traces WHERE $__orgFilter",
			"service.name",
			"SELECT ServiceName FROM traces WHERE $__orgFilter",
		],
		[
			"SELECT Events.Name FROM traces WHERE $__orgFilter",
			"Events.Name",
			"SELECT EventsName FROM traces WHERE $__orgFilter",
		],
		[
			"SELECT `Events.Name` FROM traces WHERE $__orgFilter",
			"Events.Name",
			"SELECT EventsName FROM traces WHERE $__orgFilter",
		],
		[
			"SELECT trace_id FROM logs WHERE $__orgFilter",
			"trace_id",
			"SELECT TraceId FROM logs WHERE $__orgFilter",
		],
		[
			"SELECT ServiceVersion FROM traces WHERE $__orgFilter",
			"ServiceVersion",
			"SELECT ResourceAttributes['service.version'] FROM traces WHERE $__orgFilter",
		],
		[
			"SELECT t.trace_id FROM traces t WHERE $__orgFilter(t)",
			"t.trace_id",
			"SELECT t.TraceId FROM traces t WHERE $__orgFilter(t)",
		],
	])("rewrites %s", (sql, name, expected) => {
		expect(fixUnknownIdentifier(sql, unknown(name))?.sql).toBe(expected)
	})

	it("leaves string literals and comments alone", () => {
		const sql =
			"SELECT service.name FROM traces WHERE $__orgFilter AND Body LIKE '%service.name%' -- service.name"
		expect(fixUnknownIdentifier(sql, unknown("service.name"))?.sql).toBe(
			"SELECT ServiceName FROM traces WHERE $__orgFilter AND Body LIKE '%service.name%' -- service.name",
		)
	})

	// Two candidate columns, or none on the tables read: no guess.
	it.each([
		["SELECT Severity FROM logs WHERE $__orgFilter", "Severity"],
		["SELECT CommitSha FROM service_operations_hourly WHERE $__orgFilter", "CommitSha"],
		["SELECT http.response.status_code FROM traces WHERE $__orgFilter", "http.response.status_code"],
		["SELECT Count FROM traces WHERE $__orgFilter", "Count"],
	])("does not guess for %s", (sql, name) => {
		expect(fixUnknownIdentifier(sql, unknown(name))).toBeUndefined()
	})

	// The `'` inside the backticks must not open a string literal for the masker.
	it("keeps a literal intact next to a backticked name that contains a quote", () => {
		const sql =
			"SELECT `it's`, count() FROM traces WHERE $__orgFilter AND SpanName = 'service.name' AND service.name = 'a' GROUP BY 1"
		expect(fixUnknownIdentifier(sql, unknown("service.name"))?.sql).toBe(
			"SELECT `it's`, count() FROM traces WHERE $__orgFilter AND SpanName = 'service.name' AND ServiceName = 'a' GROUP BY 1",
		)
	})

	it("fixes a column of a backtick-quoted table", () => {
		expect(
			fixUnknownIdentifier(
				"SELECT service.name FROM `traces` WHERE $__orgFilter",
				unknown("service.name"),
			)?.sql,
		).toBe("SELECT ServiceName FROM `traces` WHERE $__orgFilter")
	})

	// Only FROM/JOIN/comma positions name tables: not a literal, not an alias.
	it.each([
		[
			"SELECT service.name FROM logs WHERE $__orgFilter AND Body = '`traces`'",
			"SELECT ServiceName FROM logs WHERE $__orgFilter AND Body = '`traces`'",
		],
		[
			"SELECT service.name FROM logs AS traces WHERE $__orgFilter",
			"SELECT ServiceName FROM logs AS traces WHERE $__orgFilter",
		],
	])("fixes %s against the one table it reads", (sql, expected) => {
		expect(fixUnknownIdentifier(sql, unknown("service.name"))?.sql).toBe(expected)
	})

	it("fixes a column qualified by the alias of a backtick-quoted table", () => {
		expect(
			fixUnknownIdentifier(
				"SELECT t.trace_id FROM `traces` AS t WHERE $__orgFilter(t)",
				unknown("t.trace_id"),
			)?.sql,
		).toBe("SELECT t.TraceId FROM `traces` AS t WHERE $__orgFilter(t)")
	})

	it("fixes a qualified column only from the table the qualifier names", () => {
		const sql =
			"SELECT t.body FROM logs l JOIN traces t ON l.TraceId = t.TraceId WHERE $__orgFilter(l) AND $__orgFilter(t)"
		expect(fixUnknownIdentifier(sql, unknown("t.body"))).toBeUndefined()
		expect(fixUnknownIdentifier(sql.replace("t.body", "l.body"), unknown("l.body"))?.sql).toContain(
			"SELECT l.Body FROM",
		)
	})

	it("never renames a table alias declared without AS", () => {
		const sql = "SELECT service FROM traces service WHERE $__orgFilter(service)"
		expect(fixUnknownIdentifier(sql, unknown("service"))).toBeUndefined()
	})

	it("never renames a derived table's alias declared without AS", () => {
		const sql = "SELECT service FROM (SELECT ServiceName FROM traces WHERE $__orgFilter) service"
		expect(fixUnknownIdentifier(sql, unknown("service"))).toBeUndefined()
	})

	it("never renames a quoted, dotted derived-table alias declared without AS", () => {
		const sql =
			"SELECT service.name FROM (SELECT ServiceName FROM traces WHERE $__orgFilter) `service.name`"
		expect(fixUnknownIdentifier(sql, unknown("service.name"))).toBeUndefined()
	})

	it("never renames a quoted, dotted table alias declared without AS", () => {
		const sql = "SELECT service.name FROM traces `service.name` WHERE $__orgFilter(`service.name`)"
		expect(fixUnknownIdentifier(sql, unknown("service.name"))).toBeUndefined()
	})

	it("never renames the alias of a CTE reference", () => {
		const sql =
			"WITH s AS (SELECT ServiceName FROM traces) SELECT service FROM s service WHERE $__orgFilter(service)"
		expect(fixUnknownIdentifier(sql, unknown("service"))).toBeUndefined()
	})

	it("reads the alias of a table joined after an unaliased one", () => {
		const sql =
			"SELECT l.body FROM traces JOIN logs l ON traces.TraceId = l.TraceId WHERE $__orgFilter(l)"
		expect(fixUnknownIdentifier(sql, unknown("l.body"))?.sql).toContain("SELECT l.Body FROM")
	})

	it("declines a qualified fix when the qualifier names relations in two scopes", () => {
		const sql =
			"WITH t AS (SELECT ServiceName AS span_name FROM traces WHERE $__orgFilter) SELECT t.span_name FROM t " +
			"WHERE t.span_name IN (SELECT t.span_name FROM traces t WHERE $__orgFilter(t))"
		expect(fixUnknownIdentifier(sql, unknown("t.span_name"))).toBeUndefined()
	})

	it("ignores a table named in a # comment", () => {
		expect(
			fixUnknownIdentifier(
				"SELECT service.name FROM logs WHERE $__orgFilter #, traces",
				unknown("service.name"),
			)?.sql,
		).toBe("SELECT ServiceName FROM logs WHERE $__orgFilter #, traces")
	})

	it("fixes a column qualified by a later item of a comma-separated FROM", () => {
		const sql = "SELECT t.span_name FROM logs l, traces t WHERE $__orgFilter(l) AND $__orgFilter(t)"
		expect(fixUnknownIdentifier(sql, unknown("t.span_name"))?.sql).toContain("SELECT t.SpanName FROM")
	})

	it("never rewrites a backtick-quoted alias the query defines", () => {
		const sql =
			"SELECT ServiceName AS `service.name` FROM traces WHERE $__orgFilter ORDER BY `service.name`"
		expect(fixUnknownIdentifier(sql, unknown("service.name"))).toBeUndefined()
	})

	it("counts every table of a comma-separated FROM list", () => {
		const sql = "SELECT service_name FROM traces t, logs l WHERE $__orgFilter(t) AND $__orgFilter(l)"
		expect(fixUnknownIdentifier(sql, unknown("service_name"))).toBeUndefined()
	})

	it("does not fix an unqualified name both joined tables have", () => {
		const sql =
			"SELECT service_name FROM traces t JOIN logs l ON t.TraceId = l.TraceId WHERE $__orgFilter(t)"
		expect(fixUnknownIdentifier(sql, unknown("service_name"))).toBeUndefined()
	})

	it("never rewrites a name the query defines itself", () => {
		const sql = "SELECT ServiceName AS service FROM traces WHERE $__orgFilter ORDER BY service"
		expect(fixUnknownIdentifier(sql, unknown("service"))).toBeUndefined()
	})
})
