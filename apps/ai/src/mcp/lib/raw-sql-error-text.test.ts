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
