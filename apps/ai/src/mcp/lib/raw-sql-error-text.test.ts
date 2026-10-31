import { describe, expect, it } from "vitest"
import { rawSqlErrorText } from "./raw-sql-error-text"

describe("rawSqlErrorText", () => {
	it("collapses the gateway's per-org subquery back to the table name", () => {
		const message =
			"[Error] Unknown identifier in scope SELECT x FROM (SELECT * FROM (SELECT * FROM maple_us.traces WHERE " +
			"OrgId = 'org_a') AS maple_us.traces WHERE OrgId = 'org_a') AS traces WHERE (OrgId = 'org_a')"
		expect(rawSqlErrorText(message)).toBe(
			"[Error] Unknown identifier in scope SELECT x FROM traces WHERE $__orgFilter",
		)
	})

	// A preview or staging warehouse uses its own database name.
	it("collapses the wrapper under any database name, aliased or as a bare subquery", () => {
		const wrap = (db: string, table: string) =>
			`(SELECT * FROM (SELECT * FROM ${db}.${table} WHERE OrgId = 'org_a') AS ${db}.${table} WHERE OrgId = 'org_a')`
		expect(
			rawSqlErrorText(
				`In scope SELECT l.x FROM ${wrap("pr_1961", "logs")} AS l WHERE (l.OrgId = 'org_a')`,
			),
		).toBe("In scope SELECT l.x FROM logs AS l WHERE $__orgFilter(l)")
		expect(
			rawSqlErrorText(
				"Actual SELECT * FROM (SELECT * FROM pr_1961.traces WHERE OrgId = 'org_a') AS pr_1961.traces WHERE OrgId = 'org_a'.",
			),
		).toBe("Actual traces.")
	})

	it("keeps parentheses balanced around a wrapper with no alias", () => {
		expect(
			rawSqlErrorText(
				"x IN (SELECT * FROM (SELECT * FROM pr_1.traces WHERE OrgId = 'org_a') AS pr_1.traces WHERE OrgId = 'org_a')",
			),
		).toBe("x IN (traces)")
	})

	it("never leaves an org id or a database-qualified table behind", () => {
		expect(rawSqlErrorText("FROM pr_1961.traces WHERE OrgId = 'org_3KkfPhr7'")).toBe(
			"FROM traces WHERE OrgId = '<your org>'",
		)
	})

	it("drops the row-cap wrapper", () => {
		expect(
			rawSqlErrorText(
				"in scope SELECT * FROM ( SELECT n FROM logs ) AS maple_raw_sql_limited LIMIT 1001 SETTINGS max_execution_time=10, max_threads=2",
			),
		).toBe("in scope SELECT n FROM logs")
	})

	it("turns a datasource permission error into a plain refusal", () => {
		expect(
			rawSqlErrorText(
				"Not enough permissions for datasource 'audit_log', token needs DATASOURCES:READ:audit_log scope. curl -X PUT ...",
			),
		).toBe("`audit_log` cannot be read from run_sql.")
	})
})
