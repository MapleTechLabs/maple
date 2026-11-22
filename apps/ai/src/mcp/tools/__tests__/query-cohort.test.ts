import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Schema, String as Str } from "effect"
import { QueryCohortOutput } from "@maple/domain/mcp-outputs"
import type { McpToolResult } from "../types"
import { installFakeWarehouse, restoreWarehouse, type FixtureRule } from "../../__evals__/fake-warehouse"
import { makeEvalRuntime, markdown, runToolDirect, type EvalRuntime } from "../../__evals__/eval-runtime"

const member = (key: string, at: string) => ({
	key,
	firstAt: `${at}.000000000`,
	lastAt: `${at}.000000000`,
	count: 1,
	didTotal: 47,
	total: 12,
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
	// Everyone who did it also did the other: no member, so no row carries the totals.
	{
		match: (sql) => Str.includes("all_converted")(sql) && Str.includes("'done'")(sql),
		rows: [],
	},
	{
		match: (sql) => Str.includes("all_converted")(sql),
		rows: [{ ...member("u_1", "2026-11-01 10:00:00"), didTotal: 30, total: 30 }],
	},
	{ match: (sql) => Str.includes("nobody_does_this")(sql), rows: [] },
	{
		match: (sql) => Str.includes("cohort_events")(sql),
		rows: [member("u_132", "2026-11-06 05:04:00"), member("u_147", "2026-11-02 20:04:00")],
	},
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
	runToolDirect(rt, "query_cohort", params) as Promise<McpToolResult>

const did = JSON.stringify({ kind: "event", eventName: "workspace_created" })
const didNot = JSON.stringify({ kind: "event", eventName: "project_created" })
const window = { start_time: "2026-10-19 00:00:00", end_time: "2026-11-16 00:00:00" }
/** How often the read is bounded below by the window start. */
const lowerBounds = (sql: string): number => Str.split("e.Timestamp >= '2026-10-19 00:00:00'")(sql).length - 1

describe("query_cohort", () => {
	it("says how many did one thing and never the other, out of how many did the first", async () => {
		const result = await call({ ...window, did_json: did, did_not_json: didNot, key_by: "user" })
		expect(result.isError).toBeUndefined()
		const output = Schema.decodeUnknownSync(QueryCohortOutput)(result.structuredContent)
		expect([output.total, output.didTotal]).toEqual([12, 47])
		expect(output.members[0]).toEqual({
			id: "u_132",
			firstAt: "2026-11-06 05:04:00",
			lastAt: "2026-11-06 05:04:00",
			count: 1,
		})
		const text = markdown(result)
		expect(text).toContain(
			"**12 of the 47 users** who did workspace_created never did project_created (25.53%).",
		)
		// The totals count everyone; the table is only who fits.
		expect(text).toContain("Listing the 2 who did it last")
		expect(text).toContain('inspect_user user_id="u_132"')
	})

	it("reads all history for never, and only the window for not-in-the-window", async () => {
		await call({ ...window, did_json: did, did_not_json: didNot })
		// Only `did` is bounded below: an earlier project has to be seen to rule someone out.
		expect(lowerBounds(issued.at(-1) ?? "")).toBe(1)

		const scoped = await call({ ...window, did_json: did, did_not_json: didNot, did_not_scope: "window" })
		expect(lowerBounds(issued.at(-1) ?? "")).toBe(2)
		expect(markdown(scoped)).toContain("did not do, in the window, project_created")
	})

	it("is everyone who did it when nothing is excluded", async () => {
		const result = await call({ ...window, did_json: did, key_by: "group" })
		const text = markdown(result)
		expect(text).toContain("**12 groups** did workspace_created.")
		// A group is not a user: there is no user page to open.
		expect(text).not.toContain("inspect_user")
	})

	it("still says how many did the first thing when every one of them did the second", async () => {
		const result = await call({
			...window,
			did_json: JSON.stringify({ kind: "event", eventName: "all_converted" }),
			did_not_json: JSON.stringify({ kind: "event", eventName: "done" }),
		})
		const output = Schema.decodeUnknownSync(QueryCohortOutput)(result.structuredContent)
		expect([output.total, output.didTotal]).toEqual([0, 30])
		expect(markdown(result)).toContain(
			"**0 of the 30 persons** who did all_converted never did done (0.00%).",
		)
	})

	it("says nobody did it, with what to check", async () => {
		const result = await call({
			...window,
			did_json: JSON.stringify({ kind: "event", eventName: "nobody_does_this" }),
			key_by: "user",
		})
		const text = markdown(result)
		expect(text).toContain("No users did nobody_does_this in this window.")
		expect(text).toContain('key_by="person"')
	})

	it("refuses a session step, which nobody does", async () => {
		const result = await call({
			...window,
			did_json: JSON.stringify({ kind: "session", dimension: "country", value: "DE" }),
		})
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("did_json")
	})
})
