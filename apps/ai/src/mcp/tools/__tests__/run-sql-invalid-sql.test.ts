import { describe, expect, it } from "vitest"
import { callerSqlAsInvalidInput } from "../run-sql"
import { McpQueryBudgetError, McpQueryError } from "../types"

const invalidSql = { _tag: "@maple/http/errors/WarehouseInvalidSqlError" }
const queryErr = new McpQueryError({
	message: "There is no supertype for types String, UInt8",
	pipeName: "run_sql",
})

describe("callerSqlAsInvalidInput", () => {
	// Production: an agent wrote `countIf(StatusCode = 2)` against a String column.
	it("turns SQL the database rejected as written into a 400 on `sql`", () => {
		const mapped = callerSqlAsInvalidInput(invalidSql, queryErr)
		expect(mapped._tag).toBe("@maple/mcp/errors/McpInvalidInputError")
		expect(mapped.message).toBe(queryErr.message)
	})

	it("keeps genuine query failures as McpQueryError", () => {
		expect(callerSqlAsInvalidInput({ _tag: "@maple/http/errors/WarehouseQueryError" }, queryErr)).toBe(
			queryErr,
		)
	})

	it("keeps budget errors", () => {
		const budget = new McpQueryBudgetError({
			message: "slow",
			pipeName: "run_sql",
			setting: "max_execution_time",
		})
		expect(callerSqlAsInvalidInput(invalidSql, budget)).toBe(budget)
	})
})
