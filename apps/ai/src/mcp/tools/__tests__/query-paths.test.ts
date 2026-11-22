import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Schema, Array as Arr, String as Str } from "effect"
import { QueryPathsOutput } from "@maple/domain/mcp-outputs"
import type { McpToolResult } from "../types"
import { pathHops } from "../query-paths"
import { installFakeWarehouse, restoreWarehouse, type FixtureRule } from "../../__evals__/fake-warehouse"
import { makeEvalRuntime, markdown, runToolDirect, type EvalRuntime } from "../../__evals__/eval-runtime"

const ROWS = [
	{ hop: 1, fromNode: "signup_completed", toNode: "workspace_created", count: 60 },
	{ hop: 1, fromNode: "signup_completed", toNode: "/pricing", count: 25 },
	{ hop: 1, fromNode: "signup_completed", toNode: "", count: 15 },
	{ hop: 2, fromNode: "workspace_created", toNode: "invite_sent", count: 40 },
	{ hop: 2, fromNode: "workspace_created", toNode: "$other", count: 20 },
	{ hop: 2, fromNode: "/pricing", toNode: "invite_sent", count: 5 },
	{ hop: 2, fromNode: "/pricing", toNode: "", count: 20 },
]

describe("pathHops", () => {
	it("counts everyone who reached the anchor from the first hop, the ones who stopped included", () => {
		expect(pathHops(ROWS).total).toBe(100)
		expect(pathHops([]).total).toBe(0)
	})

	it("adds up a column's node across the ways into it, most reached first", () => {
		const second = pathHops(ROWS).hops[1]
		expect(second?.nodes).toEqual([
			{ name: "invite_sent", count: 45 },
			{ name: "", count: 20 },
			{ name: "$other", count: 20 },
		])
		expect(second?.edges[0]).toEqual({ from: "workspace_created", to: "invite_sent", count: 40 })
	})
})

const issued: Array<string> = []
const fixtures: FixtureRule[] = [
	{
		match: (sql) => {
			issued.push(sql)
			return false
		},
		rows: [],
	},
	{ match: (sql) => Str.includes("nobody_does_this")(sql), rows: [] },
	{ match: (sql) => Str.includes("path_hops")(sql), rows: ROWS },
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

const call = (params: Record<string, unknown>) =>
	runToolDirect(rt, "query_paths", params) as Promise<McpToolResult>

const anchor = JSON.stringify({ kind: "event", eventName: "signup_completed" })

describe("query_paths", () => {
	it("shows what followed the anchor, hop by hop, with the share of everyone who reached it", async () => {
		const result = await call({ anchor_json: anchor, depth: 2 })
		expect(result.isError).toBeUndefined()
		const output = Schema.decodeUnknownSync(QueryPathsOutput)(result.structuredContent)
		expect(output.total).toBe(100)
		expect(Arr.map(output.hops, (hop) => hop.hop)).toEqual([1, 2])

		const text = markdown(result)
		expect(text).toContain("Paths after signup_completed (by person, within 86400s)")
		expect(text).toContain("Reached the anchor: 100 persons")
		expect(text).toContain("| workspace_created | 60 | 60.00% |")
		// The two sentinels read as what they mean.
		expect(text).toContain("| (nothing after) | 15 | 15.00% |")
		expect(text).toContain("| workspace_created | (other) | 20 |")
		// The busiest real next step becomes the funnel that measures it.
		expect(text).toMatch(/query_funnel steps_json="\[[^\n]*signup_completed[^\n]*workspace_created/)
	})

	it("walks backward from the anchor's last occurrence when asked what led up to it", async () => {
		const result = await call({ anchor_json: anchor, direction: "before", key_by: "group" })
		const sql = issued.at(-1) ?? ""
		expect(sql).toContain("arrayReverse(evs)")
		expect(sql).toContain("e.GroupId != ''")
		const text = markdown(result)
		expect(text).toContain("Paths before signup_completed (by group")
		expect(text).toContain("| (nothing before) |")
	})

	it("says nobody did the anchor instead of printing empty hops", async () => {
		const result = await call({
			anchor_json: JSON.stringify({ kind: "event", eventName: "nobody_does_this" }),
		})
		expect(markdown(result)).toContain("Nobody did nobody_does_this in this window.")
	})

	it("refuses a depth it cannot draw, naming the parameter", async () => {
		const result = await call({ anchor_json: anchor, depth: 9 })
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("paths depth must be an integer in 1..5")
	})

	it("refuses a session step as an anchor", async () => {
		const result = await call({
			anchor_json: JSON.stringify({ kind: "session", dimension: "utmSource", value: "google" }),
		})
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("anchor_json")
	})
})
