import { describe, expect, it } from "vitest"
import type { CatalogEntryView } from "@maple/domain/data-sources"
import { exampleQuery } from "./data-source-cheat-sheet"

const entry = (name: string, time: string): CatalogEntryView => ({
	name,
	kind: "table",
	timeField: time,
	exposed: true,
	fields: [{ name: time, type: "timestamp" }],
})

describe("exampleQuery", () => {
	it("leaves plain names bare", () => {
		expect(exampleQuery("sql:clickhouse", [entry("shop.payments", "created_at")])).toBe(
			"SELECT $__timeGroup(created_at) AS t, count() AS n FROM shop.payments WHERE $__timeFilter(created_at) GROUP BY t ORDER BY t",
		)
	})

	it("quotes database, table and column names that need it, escaping backticks", () => {
		expect(exampleQuery("sql:clickhouse", [entry("my-db.order events", "event`time")])).toBe(
			"SELECT $__timeGroup(`event``time`) AS t, count() AS n FROM `my-db`.`order events` WHERE $__timeFilter(`event``time`) GROUP BY t ORDER BY t",
		)
	})
})
