import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Array as Arr, Schema } from "effect"
import {
	DataSourceConnectionError,
	DataSourceLimitError,
	DataSourceQueryError,
	DataSourceRateLimitedError,
	DataSourceTimeoutError,
} from "@maple/domain/data-sources"
import {
	DescribeDataSourceOutput,
	ListDataSourcesOutput,
	ListSourcesOutput,
	QueryDataSourceOutput,
	SearchDataSourcesOutput,
} from "@maple/domain/mcp-outputs"
import type { McpToolResult } from "../types"
import { makeEvalRuntime, markdown, runToolDirect, type EvalRuntime } from "../../__evals__/eval-runtime"
import { fakeDataSources, makeDataSourceWorld, seedDataSources } from "../../__evals__/data-source-world"

const world = makeDataSourceWorld()
let empty: EvalRuntime
let seeded: EvalRuntime
beforeAll(async () => {
	empty = makeEvalRuntime(undefined, fakeDataSources(makeDataSourceWorld()))
	seeded = makeEvalRuntime(undefined, fakeDataSources(world))
	await seeded.runtime.runPromise(seedDataSources)
})
afterAll(async () => {
	await empty.dispose()
	await seeded.dispose()
})

const decode = <S extends Schema.Codec<unknown, unknown>>(schema: S, result: McpToolResult) =>
	Schema.decodeSync(schema)(result.structuredContent)

const WINDOW = { start_time: "2026-11-01 00:00:00", end_time: "2026-11-08 00:00:00" }

describe("list_data_sources", () => {
	it("says none are connected and points to Settings when the org has none", async () => {
		const result = await runToolDirect(empty, "list_data_sources", {})
		expect(decode(ListDataSourcesOutput, result).total).toBe(0)
		expect(markdown(result)).toContain("Settings -> Data sources")
	})

	it("lists one line per agent-visible source, hiding sources with agent access off", async () => {
		const result = await runToolDirect(seeded, "list_data_sources", {})
		const output = decode(ListDataSourcesOutput, result)
		expect(Arr.map(output.sources, (s) => s.name)).toEqual([
			"clerk-prod",
			"shop-prod",
			"shop-staging",
			"warehouse-wide",
		])
		expect(output.sources.find((s) => s.name === "clerk-prod")).toMatchObject({
			kind: "clerk",
			queryLanguage: "resource",
			entryCount: 1,
		})
		expect(markdown(result)).toContain("ClickHouse SQL")
		expect(markdown(result)).not.toContain("secret-db")
	})
})

describe("search_data_sources", () => {
	it("ranks the production copy of a table above the staging one", async () => {
		const result = await runToolDirect(seeded, "search_data_sources", { query: "payments failed" })
		const hits = decode(SearchDataSourcesOutput, result).hits
		const prod = hits.findIndex((h) => h.source === "shop-prod" && h.entry === "shop.payments")
		const staging = hits.findIndex((h) => h.source === "shop-staging" && h.entry === "shop.payments")
		expect(prod).toBeGreaterThanOrEqual(0)
		expect(prod).toBeLessThan(staging)
		expect(Arr.some(hits, (h) => h.source === "secret-db")).toBe(false)
		expect(markdown(result)).toContain('describe_data_source data_source="shop-prod"')
	})
})

describe("describe_data_source", () => {
	it("pages a large source's entries instead of flooding the context", async () => {
		const result = await runToolDirect(seeded, "describe_data_source", { data_source: "warehouse-wide" })
		const output = decode(DescribeDataSourceOutput, result)
		expect(output.totalEntries).toBe(150)
		expect(output.entries).toHaveLength(100)
		expect(markdown(result)).toContain('describe_data_source data_source="warehouse-wide" offset=100')
	})

	it("gives fields, flags and a cheat sheet with macros for a SQL entry, found by its short name", async () => {
		const result = await runToolDirect(seeded, "describe_data_source", {
			data_source: "shop-prod",
			entries: ["payments"],
		})
		const text = markdown(result)
		expect(decode(DescribeDataSourceOutput, result).described?.[0]?.name).toBe("shop.payments")
		expect(text).toContain("`inserted`: timestamp (DateTime), time field")
		expect(text).toContain("`email`: string, PII")
		expect(text).not.toContain("ada@example.com")
		expect(text).toContain("$__timeGroup(inserted)")
		expect(text).toContain('query_data_source data_source="shop-prod" sql=')
	})

	it("teaches the resource query shape with an example from the source's own catalog", async () => {
		const result = await runToolDirect(seeded, "describe_data_source", {
			data_source: "clerk-prod",
			entries: ["users"],
		})
		const text = markdown(result)
		expect(text).toContain("Query language: resource query")
		expect(text).toContain(
			'{"resource":"users","measure":{"fn":"count"},"filters":[{"field":"created_at","op":"within_window"}],"groupBy":{"time":"created_at"}}',
		)
		expect(text).toContain("filter=server")
	})

	it("suggests the closest entry for a misspelt one", async () => {
		const result = await runToolDirect(seeded, "describe_data_source", {
			data_source: "shop-prod",
			entries: ["paymnts"],
		})
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain('Did you mean "shop.payments"')
	})

	it("suggests the closest source for a misspelt name, never a hidden one", async () => {
		const result = await runToolDirect(seeded, "describe_data_source", { data_source: "shop-prd" })
		expect(result.failureCategory).toBe("invalid_input")
		expect(markdown(result)).toContain("shop-prod")
		expect(markdown(result)).not.toContain("secret-db")
	})
})

describe("query_data_source", () => {
	it("states the source, language and plan first, then the rows", async () => {
		const sql =
			"SELECT status, count() AS n FROM shop.payments WHERE $__timeFilter(inserted) GROUP BY status"
		const result = await runToolDirect(seeded, "query_data_source", {
			data_source: "shop-prod",
			sql,
			...WINDOW,
		})
		const output = decode(QueryDataSourceOutput, result)
		expect(output).toMatchObject({ executed: true, rowCount: 2, queryLanguage: "sql:clickhouse" })
		const text = markdown(result)
		expect(text).toContain(
			`Data source \`shop-prod\` (ClickHouse SQL, clickhouse, production). Plan: SQL as sent: ${sql}`,
		)
		expect(text).toMatch(/\| failed\s*\| 42\s*\|/)
	})

	it("plans an API query without running it under explain", async () => {
		const before = world.runs
		const result = await runToolDirect(seeded, "query_data_source", {
			data_source: "clerk-prod",
			resource: { resource: "users", measure: { fn: "count" } },
			explain: true,
		})
		expect(decode(QueryDataSourceOutput, result).executed).toBe(false)
		expect(markdown(result)).toContain("1 API call, up to 0 rows (count)")
		expect(world.runs).toBe(before)
	})

	it("refuses SQL sent to an API source with the right form", async () => {
		const result = await runToolDirect(seeded, "query_data_source", {
			data_source: "clerk-prod",
			sql: "SELECT count(*) FROM users",
		})
		expect(result.failureCategory).toBe("invalid_input")
		expect(markdown(result)).toContain("takes a resource query, not SQL")
	})

	it("asks for exactly one of sql and resource", async () => {
		const result = await runToolDirect(seeded, "query_data_source", { data_source: "shop-prod" })
		expect(markdown(result)).toContain("Send the query")
	})

	it.each([
		[new DataSourceLimitError({ message: "too many rows" }), "query_budget"],
		[new DataSourceRateLimitedError({ message: "429", retryAfterSeconds: 30 }), "query_budget"],
		[new DataSourceConnectionError({ message: "refused", reason: "refused" }), "unavailable"],
		[new DataSourceTimeoutError({ message: "slow", timeoutMs: 1000 }), "unavailable"],
		[new DataSourceQueryError({ message: "Unknown column foo" }), "query"],
	])("maps %s to the %s failure", async (error, category) => {
		world.failWith = error
		const result = await runToolDirect(seeded, "query_data_source", {
			data_source: "shop-prod",
			sql: "SELECT 1",
		})
		world.failWith = undefined
		expect(result.failureCategory).toBe(category)
		expect(markdown(result)).toContain(error.message)
	})
})

describe("list_ingest_sources", () => {
	it("still answers to its retired name list_sources", async () => {
		const result = await runToolDirect(seeded, "list_sources", {})
		expect(result.isError).not.toBe(true)
		expect(decode(ListSourcesOutput, result).sources.length).toBeGreaterThan(0)
	})
})
