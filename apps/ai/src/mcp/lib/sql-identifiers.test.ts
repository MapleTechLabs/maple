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
