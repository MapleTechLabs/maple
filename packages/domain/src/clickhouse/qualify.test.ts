import { describe, expect, it } from "vitest"
import { qualifyStatementForDatabase } from "./qualify"

describe("qualifyStatementForDatabase", () => {
	it("qualifies a bare read of any managed table, not only materialized view sources", () => {
		expect(qualifyStatementForDatabase("DELETE FROM product_events WHERE Source = 'browser'", "db")).toBe(
			"DELETE FROM `db`.`product_events` WHERE Source = 'browser'",
		)
	})

	it("leaves names that only share a managed table's prefix alone", () => {
		const stmt = "INSERT INTO x SELECT * FROM logs_aggregates_hourly__v4 ARRAY JOIN mapKeys(m) AS k"
		expect(qualifyStatementForDatabase(stmt, "db")).toBe(stmt)
	})
})
