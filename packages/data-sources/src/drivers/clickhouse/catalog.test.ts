import { describe, expect, it } from "@effect/vitest"
import { Array as Arr, Effect, Exit, String as Str } from "effect"
import { clickHouseCatalog, MAX_CATALOG_ENTRIES } from "./catalog"
import { connection, fakeFetch, rows } from "./fake-fetch"

const isColumns = (sql: string) => Str.includes("FROM system.columns")(sql)

// Both output formats hand these values over as strings: the schemas must accept exactly that.
const table = (database: string, name: string, extra: Record<string, unknown> = {}) => ({
	database,
	name,
	engine: "MergeTree",
	total_rows: "1200",
	comment: "",
	...extra,
})
const column = (table: string, name: string, type: string, extra: Record<string, unknown> = {}) => ({
	database: "shop",
	table,
	name,
	type,
	comment: "",
	is_in_sorting_key: "0",
	...extra,
})

describe("clickHouseCatalog", () => {
	it.effect("builds entries from system tables, keyed time fields first", () => {
		const fake = fakeFetch((sql) =>
			isColumns(sql)
				? rows(
						column("payments", "created_at", "DateTime64(3)"),
						column("payments", "settled_at", "DateTime", { is_in_sorting_key: "1" }),
						column("payments", "status", "Enum8('ok' = 1, 'failed' = 2)", {
							comment: " payment state ",
						}),
						column("daily", "event_time", "DateTime"),
					)
				: rows(
						table("shop", "payments", { comment: "One row per charge" }),
						table("shop", "daily", { engine: "MaterializedView", total_rows: null }),
						table("shop", "empty"),
					),
		)
		return fake.provide(clickHouseCatalog(connection)).pipe(
			Effect.map((catalog) => {
				expect(catalog.truncated).toBe(false)
				expect(Arr.map(catalog.entries, (entry) => entry.name)).toEqual([
					"shop.payments",
					"shop.daily",
					"shop.empty",
				])
				const [payments, daily, empty] = catalog.entries
				expect(payments).toMatchObject({
					kind: "table",
					rowEstimate: 1200,
					note: "One row per charge",
					// In the sorting key beats the conventional name.
					timeField: "settled_at",
				})
				expect(payments?.fields[2]).toEqual({
					name: "status",
					type: "string",
					nativeType: "Enum8('ok' = 1, 'failed' = 2)",
					note: "payment state",
					sampleValues: ["ok", "failed"],
				})
				expect(daily).toMatchObject({ kind: "view", timeField: "event_time" })
				expect(daily?.rowEstimate).toBeUndefined()
				expect(empty?.fields).toEqual([])
				// The configured database sorts first, and the reads carry Maple's read-only settings.
				const tablesRequest = Arr.findFirst(fake.sent, (sent) => !isColumns(sent.sql))
				expect(tablesRequest._tag === "Some" && tablesRequest.value.sql).toContain(
					"ORDER BY database = 'shop' DESC",
				)
				expect(fake.sent[0]?.url.searchParams.get("readonly")).toBe("1")
			}),
		)
	})

	it.effect("caps the catalog and says so", () => {
		const fake = fakeFetch((sql) =>
			isColumns(sql)
				? rows()
				: rows(
						...Arr.makeBy(MAX_CATALOG_ENTRIES + 1, (i) =>
							table("shop", `t${Str.padStart(5, "0")(String(i))}`),
						),
					),
		)
		return fake.provide(clickHouseCatalog(connection)).pipe(
			Effect.map((catalog) => {
				expect(catalog.entries).toHaveLength(MAX_CATALOG_ENTRIES)
				expect(catalog.truncated).toBe(true)
			}),
		)
	})

	it.effect("refuses system tables of an unexpected shape with a readable error", () =>
		Effect.gen(function* () {
			const fake = fakeFetch((sql) =>
				isColumns(sql) ? rows(column("payments", "id", "UInt64", { is_in_sorting_key: 1 })) : rows(),
			)
			const exit = yield* Effect.exit(fake.provide(clickHouseCatalog(connection)))
			expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain(
				"ClickHouse's system tables had an unexpected shape.",
			)
		}),
	)
})
