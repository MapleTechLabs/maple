import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Schema, Array as Arr, String as Str } from "effect"
import { ExploreAttributesOutput, QueryDataOutput } from "@maple/domain/mcp-outputs"
import type { McpToolResult } from "../types"
import { installFakeWarehouse, restoreWarehouse, type FixtureRule } from "../../__evals__/fake-warehouse"
import { makeEvalRuntime, markdown, runToolDirect, type EvalRuntime } from "../../__evals__/eval-runtime"

// query_data and explore_attributes on product events, through the registry as a client reaches
// them. The fake warehouse records each SQL statement, so a test can read what was asked.
const issued: Array<string> = []
const lastSql = (): string => issued.at(-1) ?? ""

const fixtures: FixtureRule[] = [
	{
		match: (sql) => {
			issued.push(sql)
			return false
		},
		rows: [],
	},
	{
		match: (sql) => /arrayJoin\(mapKeys\(product_events\.Attributes\)\)/.test(sql),
		rows: [
			{ attributeKey: "format", usageCount: 213 },
			{ attributeKey: "rows", usageCount: 180 },
		],
	},
	{
		match: (sql) => Str.includes("AS attributeValue")(sql),
		rows: [
			{ attributeValue: "csv", usageCount: 130 },
			{ attributeValue: "pdf", usageCount: 62 },
		],
	},
	{ match: (sql) => /FROM product_events/.test(sql), rows: [{ name: "plan_started", value: 1797 }] },
	{ match: () => true, rows: [] },
]

let rt: EvalRuntime

beforeAll(() => {
	installFakeWarehouse(fixtures)
	rt = makeEvalRuntime()
})

afterAll(async () => {
	restoreWarehouse()
	await rt.dispose()
})

const call = (name: string, params: Record<string, unknown>) =>
	runToolDirect(rt, name, params) as Promise<McpToolResult>

const breakdown = { source: "product_events", kind: "breakdown" }

describe("query_data on product events", () => {
	it("defaults to the last seven days, and says so", async () => {
		const result = await call("query_data", { ...breakdown, group_by: "event_name" })
		expect(result.isError).toBeUndefined()
		const output = Schema.decodeUnknownSync(QueryDataOutput)(result.structuredContent)
		const span = Date.parse(`${output.timeRange.end}Z`) - Date.parse(`${output.timeRange.start}Z`)
		expect(span).toBe(7 * 86_400_000)
		expect(markdown(result)).toContain("start_time: defaulted to 7 days before end_time")
	})

	it("keeps the six-hour default for spans", async () => {
		const result = await call("query_data", { source: "traces", kind: "timeseries" })
		const output = Schema.decodeUnknownSync(QueryDataOutput)(result.structuredContent)
		const span = Date.parse(`${output.timeRange.end}Z`) - Date.parse(`${output.timeRange.start}Z`)
		expect(span).toBe(6 * 3_600_000)
	})

	it("adds up a numeric property", async () => {
		const result = await call("query_data", {
			...breakdown,
			metric: "sum",
			value_attribute: "amount",
			event_name: ["plan_started"],
		})
		expect(result.isError).toBeUndefined()
		expect(lastSql()).toContain("toFloat64OrNull(product_events.Attributes['amount'])")
		expect(markdown(result)).toContain("| Name | sum(amount) |")
	})

	it("sums when a property is named and no metric is", async () => {
		const result = await call("query_data", { ...breakdown, value_attribute: "amount" })
		const output = Schema.decodeUnknownSync(QueryDataOutput)(result.structuredContent)
		expect(output.metric).toBe("sum")
		expect(markdown(result)).toContain('metric: defaulted to "sum"')
	})

	it("asks for the property a numeric metric reads", async () => {
		const result = await call("query_data", { ...breakdown, metric: "avg" })
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("`value_attribute`")
		expect(markdown(result)).toContain("explore_attributes source=product_events")
	})

	it("refuses a property with a metric that does not read one", async () => {
		const result = await call("query_data", { ...breakdown, metric: "users", value_attribute: "amount" })
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("metric=users counts events or identities")
	})

	it("groups by a session dimension and filters on another", async () => {
		const result = await call("query_data", {
			...breakdown,
			metric: "visitors",
			group_by: "utm_source",
			country: "DE",
		})
		expect(result.isError).toBeUndefined()
		const sql = Arr.findLast(issued, (text) => Str.includes("max(session_replays.UtmSource)")(text))
		expect(sql._tag).toBe("Some")
		expect(lastSql()).toContain("session_replays.Country = 'DE'")
		const text = markdown(result)
		expect(text).toContain("Sessions: country = DE")
		// The caveat that changes how the number reads: server events have no session.
		expect(text).toContain("Server-side events have no session")
	})

	it("refuses a session filter on a source that has no sessions", async () => {
		const result = await call("query_data", { source: "traces", kind: "timeseries", country: "DE" })
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("`country` applies to source=product_events only")
	})
})

describe("explore_attributes on product events", () => {
	it("lists an event's properties and points at their values", async () => {
		const result = await call("explore_attributes", {
			source: "product_events",
			event_name: "report_exported",
		})
		expect(result.isError).toBeUndefined()
		const output = Schema.decodeUnknownSync(ExploreAttributesOutput)(result.structuredContent)
		expect(output.keys).toEqual([
			{ key: "format", count: 213 },
			{ key: "rows", count: 180 },
		])
		expect(output.eventName).toBe("report_exported")
		expect(lastSql()).toContain("EventName IN ('report_exported')")
		const text = markdown(result)
		expect(text).toContain("product events (report_exported)")
		expect(text).toContain('explore_attributes source="product_events" key="format"')
		expect(text).toContain('event_name="report_exported"')
	})

	it("lists a property's values and offers the breakdown by it", async () => {
		const result = await call("explore_attributes", {
			source: "product_events",
			event_name: "report_exported",
			key: "format",
		})
		const output = Schema.decodeUnknownSync(ExploreAttributesOutput)(result.structuredContent)
		expect(output.values?.[0]).toEqual({ value: "csv", count: 130 })
		const text = markdown(result)
		expect(text).toContain("| csv | 130 |")
		expect(text).toContain('group_by="attribute" attribute_key="format"')
	})

	it("reads a week by default, where spans read six hours", async () => {
		const result = await call("explore_attributes", { source: "product_events" })
		const output = Schema.decodeUnknownSync(ExploreAttributesOutput)(result.structuredContent)
		const span = Date.parse(`${output.timeRange.end}Z`) - Date.parse(`${output.timeRange.start}Z`)
		expect(span).toBe(7 * 86_400_000)
	})
})
