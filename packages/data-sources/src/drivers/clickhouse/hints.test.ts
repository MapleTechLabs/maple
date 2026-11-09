import { describe, expect, it } from "vitest"
import type { SourceCatalog } from "@maple/domain/data-sources"
import { runtimeHint, validationHints } from "./hints"

const catalog: SourceCatalog = {
	entries: [
		{
			name: "shop.payments",
			kind: "table",
			fields: [
				{ name: "amount", type: "number" },
				{ name: "created_at", type: "timestamp" },
			],
		},
	],
	examples: [],
	truncated: false,
}

describe("validationHints", () => {
	it("names each PostgreSQL or MySQL habit with the ClickHouse fix", () => {
		const hint = validationHints(
			"SELECT date_trunc('day', created_at), x::int FROM t WHERE ts > NOW() - interval '1 day'",
		)
		expect(hint).toContain(
			"This source is ClickHouse; `date_trunc` is PostgreSQL. Use `$__timeGroup(created_at)`",
		)
		expect(hint).toContain("`::type` is PostgreSQL")
		expect(hint).toContain("Use `INTERVAL 1 DAY`")
		expect(validationHints("SELECT DATE_FORMAT(ts, '%Y')")).toContain("`DATE_FORMAT` is MySQL")
	})

	it("says nothing about ClickHouse SQL or habits inside literals", () => {
		expect(validationHints("SELECT toStartOfInterval(ts, INTERVAL 1 DAY), 'date_trunc(' FROM t")).toBe("")
	})
})

describe("runtimeHint", () => {
	it("explains the unknown function ClickHouse named, not every habit in the query", () => {
		const message =
			"Function with name `generate_series` does not exist. In scope SELECT generate_series(1, 3)."
		const hint = runtimeHint("SELECT generate_series(1, 3), x::int", "46", message, catalog)
		expect(hint).toContain("`generate_series` is PostgreSQL. Use `range(start, end)`")
		expect(hint).not.toContain("::type")
	})

	it("shows how to bucket an epoch-seconds column when toStartOfInterval refuses it", () => {
		const message =
			"Illegal type UInt32 of 1st argument of function toStartOfInterval, expected a Date, Date32, DateTime or DateTime64"
		const hint = runtimeHint("SELECT $__timeGroup(ts) FROM iot.readings", "43", message, catalog)
		expect(hint).toContain("toStartOfInterval(toDateTime(ts)")
	})

	it("suggests catalog columns for an unknown identifier and tables for an unknown table", () => {
		expect(
			runtimeHint(
				"SELECT amout FROM shop.payments",
				"47",
				"Unknown expression identifier `amout` in scope SELECT amout",
				catalog,
			),
		).toBe(" Did you mean `amount`?")
		expect(
			runtimeHint("SELECT 1 FROM shop.paymnts", "60", "Table shop.paymnts does not exist.", catalog),
		).toBe(" Did you mean `shop.payments`?")
	})
})
