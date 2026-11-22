import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Schema, Array as Arr, String as Str } from "effect"
import { QueryRetentionOutput } from "@maple/domain/mcp-outputs"
import type { McpToolResult } from "../types"
import { retentionTable } from "../query-retention"
import { installFakeWarehouse, restoreWarehouse, type FixtureRule } from "../../__evals__/fake-warehouse"
import { makeEvalRuntime, markdown, runToolDirect, type EvalRuntime } from "../../__evals__/eval-runtime"

const DAY_MS = 86_400_000
const at = (day: string): number => Date.parse(`${day}T00:00:00Z`)

describe("retentionTable", () => {
	const rows = [
		{ cohort: "2026-10-05", period: 0, count: 40 },
		{ cohort: "2026-10-05", period: 1, count: 20 },
		{ cohort: "2026-10-05", period: 3, count: 8 },
		{ cohort: "2026-10-12", period: 0, count: 10 },
		{ cohort: "2026-10-12", period: 1, count: 4 },
	]

	it("lays the periods out per cohort, a period nobody came back in as zero", () => {
		const table = retentionTable(rows, "week", 3, at("2026-12-01"))
		expect(table.cohorts).toEqual([
			{ cohort: "2026-10-05", size: 40, returned: [20, 0, 8], completePeriods: 3, startedPeriods: 3 },
			{ cohort: "2026-10-12", size: 10, returned: [4, 0, 0], completePeriods: 3, startedPeriods: 3 },
		])
		// Weighted by cohort size: (20 + 4) of (40 + 10), not the mean of 50% and 40%.
		expect(table.overall).toEqual([24 / 50, 0, 8 / 50])
	})

	it("tells a period that has not happened from one nobody returned in", () => {
		// Read through Wednesday 2026-10-21: the older cohort's second week is running, the
		// younger one's first is, and nothing later has started.
		const table = retentionTable(rows, "week", 3, at("2026-10-21") + DAY_MS / 2)
		expect(Arr.map(table.cohorts, (cohort) => [cohort.completePeriods, cohort.startedPeriods])).toEqual([
			[1, 2],
			[0, 1],
		])
		// Only the cohort old enough to have finished week 1 counts toward it; nothing has finished week 2.
		expect(table.overall).toEqual([20 / 40, null, null])
	})

	it("steps months by the calendar, not by 30 days", () => {
		const monthly = retentionTable(
			[{ cohort: "2026-01-01", period: 0, count: 5 }],
			"month",
			2,
			at("2026-03-01"),
		)
		// February ended on the 28th, so its month is complete on March 1st; March has only started.
		expect(monthly.cohorts[0]).toMatchObject({ completePeriods: 1, startedPeriods: 2 })
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
	{
		match: (sql) => Str.includes("account_only")(sql) && Str.includes("withSession")(sql),
		rows: [
			{
				step: 1,
				events: 15,
				withPerson: 0,
				withUser: 0,
				withVisitor: 0,
				withGroup: 15,
				withSession: 0,
			},
		],
	},
	{ match: (sql) => Str.includes("account_only")(sql), rows: [] },
	{
		match: (sql) => Str.includes("retention_events")(sql),
		rows: [
			{ cohort: "2026-10-05", period: 0, count: 40 },
			{ cohort: "2026-10-05", period: 1, count: 20 },
			{ cohort: "2026-10-05", period: 2, count: 10 },
		],
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

/** How often the read is bounded below by the window start: once on returns, twice with firsts too. */
const lowerBounds = (sql: string): number => Str.split("e.Timestamp >= '2026-10-05 00:00:00'")(sql).length - 1

const call = (params: Record<string, unknown>) =>
	runToolDirect(rt, "query_retention", params) as Promise<McpToolResult>

const window = { start_time: "2026-10-05 00:00:00", end_time: "2026-10-12 00:00:00" }

describe("query_retention", () => {
	it("reads firsts over all history by default, and only the two named events", async () => {
		const result = await call({
			...window,
			start_json: JSON.stringify({ kind: "event", eventName: "signup_completed" }),
			return_json: JSON.stringify({ kind: "event", eventName: "report_exported" }),
			periods: 2,
		})
		expect(result.isError).toBeUndefined()
		const sql = issued.at(-1) ?? ""
		// Only returns are bounded below: a first before the window has to be seen to be excluded.
		expect(lowerBounds(sql)).toBe(1)
		expect(sql).toContain("e.EventName = 'signup_completed' OR e.EventName = 'report_exported'")
		expect(sql).toContain("toStartOfWeek(ts, 1, 'UTC')")
		// The cohort window is applied to each key's first start event.
		expect(sql).toMatch(/first >= '2026-10-05 00:00:00'/)

		const output = Schema.decodeUnknownSync(QueryRetentionOutput)(result.structuredContent)
		expect(output.firstEver).toBe(true)
		expect(output.cohorts).toEqual([
			{ cohort: "2026-10-05", size: 40, returned: [20, 10], completePeriods: 2, startedPeriods: 2 },
		])
		const text = markdown(result)
		expect(text).toContain("| 2026-10-05 | 40 | 20 (50.00%) | 10 (25.00%) |")
		expect(text).toContain("New means: first time ever, over all history")
	})

	it("bounds the read to the window when first_ever is off", async () => {
		await call({
			...window,
			first_ever: false,
			return_json: JSON.stringify({ kind: "event", eventName: "report_exported" }),
		})
		expect(lowerBounds(issued.at(-1) ?? "")).toBe(2)
	})

	it("counts accounts with key_by group", async () => {
		const result = await call({ ...window, key_by: "group" })
		expect(issued.at(-1) ?? "").toContain("e.GroupId != ''")
		expect(markdown(result)).toContain("Retention by week (groups;")
	})

	it("explains an empty result by what new means", async () => {
		const result = await call({
			...window,
			start_json: JSON.stringify({ kind: "event", eventName: "nobody_does_this" }),
		})
		const text = markdown(result)
		expect(text).toContain("for the first time in this window")
		expect(text).toContain("first_ever=false")
	})

	it("says when the start event carries an account and no person, and offers cohorts by group", async () => {
		const result = await call({
			...window,
			start_json: JSON.stringify({ kind: "event", eventName: "account_only" }),
		})
		const output = Schema.decodeUnknownSync(QueryRetentionOutput)(result.structuredContent)
		expect(output.cohorts).toEqual([])
		expect(output.suggestedKeyBy).toBe("group")
		const text = markdown(result)
		expect(text).toContain("account_only matched 15 events, but none carries a user id or a visitor id")
		expect(text).toMatch(/Next:\n- `query_retention [^\n]*key_by="group"/)
		// The generic hint would compete with the reason just given.
		expect(text).not.toContain("first_ever=false")
	})

	it("rejects a period count it cannot report", async () => {
		const result = await call({ ...window, periods: 40 })
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("periods must be a whole number from 1 to 26")
	})

	it("rejects a session step, which no history contains", async () => {
		const result = await call({
			...window,
			start_json: JSON.stringify({ kind: "session", dimension: "utmSource", value: "google" }),
		})
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("start_json")
	})
})
