import { describe, expect, it } from "vitest"
import {
	cellToString,
	toJson,
	withColumnListOnUnknownColumn,
	withRollupHintOnBudget,
	withTableListOnUnknownTable,
} from "../run-sql"
import { McpQueryBudgetError, McpQueryError } from "../types"

const err = (message: string) => new McpQueryError({ message, pipeName: "run_sql" })

describe("run_sql unknown-table hints", () => {
	it.each([
		["Resource 'otel_traces' not found", "SELECT count() FROM otel_traces WHERE $__orgFilter", "traces"],
		["Unknown table expression identifier 'spans'", "SELECT 1 FROM spans WHERE $__orgFilter", "traces"],
		[
			"Resource 'otel_metrics_sum' not found",
			"SELECT 1 FROM otel_metrics_sum WHERE $__orgFilter",
			"metrics_sum",
		],
	])("suggests the real table for %s", (message, sql, table) => {
		expect(withTableListOnUnknownTable(err(message), sql).message).toContain(`did you mean \`${table}\``)
	})

	it("does not suggest anything for a CTE name", () => {
		const sql = "WITH events AS (SELECT 1 FROM traces WHERE $__orgFilter) SELECT * FROM events JOIN nope"
		const message = withTableListOnUnknownTable(err("Unknown table nope"), sql).message
		expect(message).not.toContain("did you mean")
		expect(message).toContain("Available tables:")
	})
})

describe("run_sql unknown-column hints", () => {
	const sql = "SELECT HourBucket FROM traces WHERE $__orgFilter"

	// The analyzer's current wording, which the old pattern missed entirely.
	it("lists the real columns for an `Unknown expression identifier` typo", () => {
		const message = withColumnListOnUnknownColumn(sql)(
			err("[Error] Unknown expression identifier `HourBucket` in scope SELECT HourBucket FROM traces"),
		).message
		expect(message).toContain("Columns available:")
		expect(message).toContain("SpanName")
		expect(message).not.toContain("schema apply")
	})

	it("mentions schema apply only for a column Maple's schema has", () => {
		const message = withColumnListOnUnknownColumn("SELECT SampleRate FROM traces WHERE $__orgFilter")(
			err("Unknown expression identifier `SampleRate` in scope"),
		).message
		expect(message).toContain("schema apply")
	})

	it("blames an out-of-scope alias rather than the schema", () => {
		const message = withColumnListOnUnknownColumn(
			"SELECT 1 FROM traces WHERE $__orgFilter AND t.OrgId != ''",
		)(err("Unknown expression identifier `t.OrgId` in scope")).message
		expect(message).toContain("`t` is not an alias in scope")
		expect(message).not.toContain("schema apply")
	})

	it("explains a table-less SELECT instead of an unknown OrgId", () => {
		const message = withColumnListOnUnknownColumn("SELECT now() WHERE $__orgFilter")(
			err("Unknown expression or function identifier `OrgId` in scope SELECT now()"),
		).message
		expect(message).toContain("has no FROM")
	})
})

describe("run_sql budget hint", () => {
	it("names rollup tables on a timeout", () => {
		const error = withRollupHintOnBudget(
			new McpQueryBudgetError({
				message: "Too slow.",
				pipeName: "run_sql",
				setting: "max_execution_time",
			}),
		)
		expect(error.message).toContain("service_operations_hourly")
		expect(error.message).toContain("trace_list_mv")
	})
})

describe("run_sql cells", () => {
	it("keeps control characters visible and honours the cell cap", () => {
		expect(cellToString("a\nb\tc")).toBe("a\\nb\\tc")
		expect(cellToString("x".repeat(300), 200)).toHaveLength(200)
		expect(cellToString("x".repeat(100))).toHaveLength(100)
	})
})

describe("run_sql values", () => {
	it("rounds binary float noise but keeps integers and bigints exact", () => {
		expect(toJson(8282.599999999999)).toBe(8282.6)
		expect(toJson(0.1 + 0.2)).toBe(0.3)
		expect(toJson(42)).toBe(42)
		expect(toJson(9159505022091740238n)).toBe("9159505022091740238")
	})
})
