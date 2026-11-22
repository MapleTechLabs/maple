import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Context, Effect, Schema, Array as Arr, String as Str } from "effect"
import { WarehouseExecutor, productEventsFunnel } from "@maple/query-engine/observability"
import { CH } from "@maple/query-engine"
import { OrgId } from "@maple/domain/http"
import { ListProductEventsOutput, QueryFunnelOutput } from "@maple/domain/mcp-outputs"
import type { McpToolResult } from "../types"
import { compiledQueryOf } from "@maple/query-engine/execution"
import { installFakeWarehouse, restoreWarehouse, type FixtureRule } from "../../__evals__/fake-warehouse"
import { makeEvalRuntime, markdown, runToolDirect, type EvalRuntime } from "../../__evals__/eval-runtime"

// Both tools run through the registry the way a client reaches them, against a fake warehouse
// that answers the funnel read with two steps and the event-name read with one custom event.
/** Every funnel query reads its rows under this alias; the event-name read does not. */
const isFunnelRead = (sql: string): boolean => Str.includes("funnel_events")(sql)

/** The identity coverage read: the one query that counts events per identity. */
const isCoverageRead = (sql: string): boolean => Str.includes("withSession")(sql)

const fixtures: FixtureRule[] = [
	// A second step nobody reaches; the detail reads below still answer for it.
	{
		match: (sql) =>
			Str.includes("unreached_step")(sql) &&
			isFunnelRead(sql) &&
			!Str.includes("sinceStartP50Ms")(sql) &&
			!/\bAS next\b/.test(sql),
		rows: [
			{ step: 1, count: 25 },
			{ step: 2, count: 0 },
		],
	},
	// Seven events with a session and no visitor id: by visitor nobody can match.
	{
		match: (sql) => Str.includes("anon_step")(sql) && isCoverageRead(sql),
		rows: [
			{ step: 1, events: 7, withPerson: 0, withUser: 0, withVisitor: 0, withGroup: 0, withSession: 7 },
		],
	},
	{ match: (sql) => Str.includes("anon_step")(sql), rows: [] },
	// A billing event that carries the account and no user, after a step that carries both.
	{
		match: (sql) => Str.includes("billing_only")(sql) && isCoverageRead(sql),
		rows: [
			{
				step: 1,
				events: 30,
				withPerson: 30,
				withUser: 30,
				withVisitor: 30,
				withGroup: 30,
				withSession: 30,
			},
			{
				step: 2,
				events: 18,
				withPerson: 0,
				withUser: 0,
				withVisitor: 0,
				withGroup: 18,
				withSession: 0,
			},
		],
	},
	{
		match: (sql) => Str.includes("billing_only")(sql) && isFunnelRead(sql),
		rows: [
			{ step: 1, count: 25 },
			{ step: 2, count: 0 },
		],
	},
	{
		match: (sql) => /product_events/i.test(sql) && Str.includes("collapsed.test")(sql),
		rows: [
			{ eventName: "page_view", kind: "navigation", count: 40, sessions: 12, persons: 0, groups: 0 },
		],
	},
	// The breakdown read names the attribute it groups by.
	{
		match: (sql) => isFunnelRead(sql) && Str.includes("'plan'")(sql),
		rows: [{ group: "pro", step: 1, count: 10 }],
	},
	// The warehouse gives up on one funnel's detail reads; its counts still come back.
	{
		match: (sql) => Str.includes("slow_details")(sql) && Str.includes("sinceStartP50Ms")(sql),
		failure: { message: "Timeout exceeded", type: "TIMEOUT_EXCEEDED" },
	},
	// The two detail reads: the time between steps, then where the drop-offs went.
	{
		match: (sql) => Str.includes("sinceStartP50Ms")(sql),
		rows: [
			{
				step: 2,
				p50Ms: 99_000_000,
				p90Ms: 190_000_000,
				sinceStartP50Ms: 99_000_000,
				sinceStartP90Ms: 190_000_000,
			},
		],
	},
	{
		match: (sql) => /\bAS next\b/.test(sql) && isFunnelRead(sql),
		rows: [
			{ step: 2, next: "/welcome", count: 45 },
			{ step: 2, next: "", count: 15 },
		],
	},
	{
		match: (sql) => isFunnelRead(sql),
		rows: [
			{ step: 1, count: 100 },
			{ step: 2, count: 40 },
		],
	},
	{
		match: (sql) => /product_events/i.test(sql),
		rows: [
			{ eventName: "signup_completed", kind: "custom", count: 12, sessions: 10, persons: 9, groups: 4 },
			// A billing webhook's event: the account, and nobody.
			{ eventName: "plan_started", kind: "custom", count: 6, sessions: 0, persons: 0, groups: 6 },
		],
	},
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

describe("query_funnel identity", () => {
	it("names an empty VisitorId instead of reporting nobody matched", async () => {
		const result = await call("query_funnel", {
			steps_json: JSON.stringify([{ kind: "event", eventName: "anon_step" }]),
			key_by: "visitor",
		})
		const output = Schema.decodeUnknownSync(QueryFunnelOutput)(result.structuredContent)
		expect(output.identityNote).toContain("matched 7 events, but none carries a visitor id")
		expect(output.suggestedKeyBy).toBe("session")
		expect(markdown(result)).toContain('key_by="session"')
	})

	it("says a step is empty for want of a user id, and offers the funnel by group", async () => {
		const result = await call("query_funnel", {
			steps_json: JSON.stringify([
				{ kind: "event", eventName: "checkout_started" },
				{ kind: "event", eventName: "billing_only" },
			]),
		})
		const output = Schema.decodeUnknownSync(QueryFunnelOutput)(result.structuredContent)
		expect(output.steps[1]?.count).toBe(0)
		expect(output.identityNote).toContain("Step 2 (billing_only) matched 18 events")
		expect(output.identityNote).not.toContain("Step 1")
		expect(output.suggestedKeyBy).toBe("group")
		// The first suggested call repeats the funnel under the key that works.
		expect(markdown(result)).toMatch(/Next:\n- `query_funnel [^\n]*key_by="group"/)
	})

	it("keeps the filters, the window and the breakdown in the funnel it offers under another key", async () => {
		const result = await call("query_funnel", {
			steps_json: JSON.stringify([
				{ kind: "event", eventName: "checkout_started" },
				{ kind: "event", eventName: "billing_only" },
			]),
			window_seconds: 3600,
			country: "DE",
		})
		// Without them the retry would count the whole organization, not the people asked about.
		expect(markdown(result)).toMatch(
			/Next:\n- `query_funnel [^\n]*window_seconds=3600[^\n]*country="DE"[^\n]*key_by="group"/,
		)
	})

	it("does not read the coverage when every step has people", async () => {
		const result = await call("query_funnel", {
			steps_json: JSON.stringify([
				{ kind: "page", pagePath: "/pricing" },
				{ kind: "event", eventName: "signup_completed" },
			]),
		})
		const output = Schema.decodeUnknownSync(QueryFunnelOutput)(result.structuredContent)
		expect(output.identityNote).toBeUndefined()
		expect(output.suggestedKeyBy).toBeUndefined()
	})

	it("counts by group", async () => {
		const result = await call("query_funnel", {
			steps_json: JSON.stringify([
				{ kind: "page", pagePath: "/pricing" },
				{ kind: "event", eventName: "signup_completed" },
			]),
			key_by: "group",
		})
		expect(result.isError).toBeUndefined()
		expect(markdown(result)).toContain("| # | Step | Groups |")
	})
})

describe("query_funnel validation", () => {
	it("rejects malformed steps_json as a parameter error", async () => {
		const result = await call("query_funnel", { steps_json: "not json" })
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("steps_json")
	})

	it("rejects a step of an unknown kind", async () => {
		const result = await call("query_funnel", {
			steps_json: JSON.stringify([{ kind: "click", target: "#buy" }]),
		})
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("steps_json")
	})

	it("rejects an empty step list with the example", async () => {
		const result = await call("query_funnel", { steps_json: "[]" })
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("at least one step")
		expect(markdown(result)).toContain('"kind":"page"')
	})

	it("rejects a session step past step 1 before touching the warehouse", async () => {
		const result = await call("query_funnel", {
			steps_json: JSON.stringify([
				{ kind: "event", eventName: "signup_completed" },
				{ kind: "session", dimension: "utmSource", value: "twitter" },
			]),
		})
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("only valid as step 1")
	})

	it("rejects an unknown key_by and a non-positive window", async () => {
		const steps = JSON.stringify([{ kind: "event", eventName: "x" }])
		const keyBy = await call("query_funnel", { steps_json: steps, key_by: "account" })
		expect(keyBy.isError).toBe(true)
		expect(markdown(keyBy)).toContain("`key_by`")

		const window = await call("query_funnel", { steps_json: steps, window_seconds: 0 })
		expect(window.isError).toBe(true)
		expect(markdown(window)).toContain("window_seconds")
	})

	it("rejects a breakdown_by outside the vocabulary but accepts attribute:<key>", async () => {
		const steps = JSON.stringify([{ kind: "event", eventName: "x" }])
		const bad = await call("query_funnel", { steps_json: steps, breakdown_by: "plan" })
		expect(bad.isError).toBe(true)
		expect(markdown(bad)).toContain("breakdown_by must be one of")
		const good = await call("query_funnel", { steps_json: steps, breakdown_by: "attribute:plan" })
		expect(good.isError).toBeUndefined()
	})

	it("takes the steps as an array as well as JSON text", async () => {
		const result = await call("query_funnel", { steps_json: [{ kind: "page", pagePath: "/pricing" }] })
		expect(result.isError).toBeUndefined()
	})
})

describe("query_funnel output", () => {
	it("decodes with its output schema and renders the conversion", async () => {
		const steps = [
			{ kind: "page", pagePath: "/pricing" },
			{ kind: "event", eventName: "signup_completed" },
		]
		const result = await call("query_funnel", { steps_json: JSON.stringify(steps) })
		const output = Schema.decodeUnknownSync(QueryFunnelOutput)(result.structuredContent)
		expect(Arr.map(output.steps, (step) => step.count)).toEqual([100, 40])
		expect(output.conversion).toBeCloseTo(0.4)
		expect(output.definition).toEqual(steps)
		const text = markdown(result)
		expect(text).toContain("**Conversion: 40.00%**")
		// The breakdown suggestion repeats the funnel, so it decodes against this tool's schema.
		expect(text).toContain("`query_funnel steps_json=")
		expect(text).toContain('breakdown_by="utmSource"')
	})

	it("offers the breakdown of the same funnel: its key, window and filters", async () => {
		const result = await call("query_funnel", {
			steps_json: JSON.stringify([
				{ kind: "page", pagePath: "/pricing" },
				{ kind: "event", eventName: "signup_completed" },
			]),
			key_by: "group",
			window_seconds: 7200,
			utm_source: "newsletter",
		})
		expect(markdown(result)).toMatch(
			/query_funnel [^\n]*window_seconds=7200[^\n]*utm_source="newsletter"[^\n]*key_by="group"[^\n]*breakdown_by="utmSource"/,
		)
	})
})

describe("query_funnel details", () => {
	const steps = JSON.stringify([
		{ kind: "page", pagePath: "/pricing" },
		{ kind: "event", eventName: "signup_completed" },
	])

	it("adds the time each step took and where the drop-offs went, only when asked", async () => {
		const plain = await call("query_funnel", { steps_json: steps })
		expect(markdown(plain)).not.toContain("Time to convert")

		const result = await call("query_funnel", { steps_json: steps, details: true })
		const output = Schema.decodeUnknownSync(QueryFunnelOutput)(result.structuredContent)
		expect(output.steps[1]).toMatchObject({
			p50Ms: 99_000_000,
			leavers: [
				{ name: "/welcome", count: 45 },
				{ name: "", count: 15 },
			],
		})
		expect(output.steps[0]?.p50Ms).toBeUndefined()
		const text = markdown(result)
		expect(text).toContain("| 2 | signup_completed | 1d 4h | 2d 5h | 1d 4h |")
		expect(text).toContain("Before step 2 (signup_completed): /welcome (45), nothing after (15)")
	})

	it("reports no time to a step nobody reached", async () => {
		const result = await call("query_funnel", {
			steps_json: JSON.stringify([
				{ kind: "event", eventName: "signup_completed" },
				{ kind: "event", eventName: "unreached_step" },
			]),
			details: true,
		})
		const output = Schema.decodeUnknownSync(QueryFunnelOutput)(result.structuredContent)
		// The timing read answers zeros for a step with no converters; they are not a measurement.
		expect(output.steps[1]?.count).toBe(0)
		expect(output.steps[1]?.p50Ms).toBeUndefined()
		expect(output.steps[1]?.leavers).toBeDefined()
	})

	it("leaves the details out of a breakdown, which has no single chain to time", async () => {
		const result = await call("query_funnel", {
			steps_json: steps,
			details: true,
			breakdown_by: "attribute:plan",
		})
		expect(markdown(result)).not.toContain("Time to convert")
	})

	it("says sessions are kept 30 days when a longer window reads them", async () => {
		const window = { start_time: "2026-08-01 00:00:00", end_time: "2026-10-15 00:00:00" }
		const filtered = await call("query_funnel", { steps_json: steps, ...window, country: "DE" })
		expect(markdown(filtered)).toContain("Sessions are kept 30 days")
		const unfiltered = await call("query_funnel", { steps_json: steps, ...window })
		expect(markdown(unfiltered)).not.toContain("Sessions are kept 30 days")
	})

	it("goes by how old the window is, not how long: three old days are as blind", async () => {
		const old = { start_time: "2026-08-01 00:00:00", end_time: "2026-08-04 00:00:00" }
		const filtered = await call("query_funnel", { steps_json: steps, ...old, country: "DE" })
		expect(markdown(filtered)).toContain("Sessions are kept 30 days")
		// The default window is the last week, all of it inside what is kept.
		const recent = await call("query_funnel", { steps_json: steps, country: "DE" })
		expect(markdown(recent)).not.toContain("Sessions are kept 30 days")
	})

	it("says the details could not be read instead of leaving the section out silently", async () => {
		const result = await call("query_funnel", {
			steps_json: JSON.stringify([
				{ kind: "page", pagePath: "/pricing" },
				{ kind: "event", eventName: "slow_details" },
			]),
			details: true,
		})
		expect(result.isError).toBeUndefined()
		const output = Schema.decodeUnknownSync(QueryFunnelOutput)(result.structuredContent)
		expect(output.detailsNote).toContain("could not be read")
		const text = markdown(result)
		expect(text).toContain("the counts are complete")
		expect(text).not.toContain("### Time to convert")
	})
})

describe("query_funnel exclusions", () => {
	const steps = JSON.stringify([
		{ kind: "page", pagePath: "/pricing" },
		{ kind: "event", eventName: "signup_completed" },
	])
	const exclusions = JSON.stringify([{ step: { kind: "event", eventName: "support_opened" } }])

	it("reads the excluded event with the steps and names it in the result", async () => {
		const result = await call("query_funnel", { steps_json: steps, exclusions_json: exclusions })
		expect(result.isError).toBeUndefined()
		const output = Schema.decodeUnknownSync(QueryFunnelOutput)(result.structuredContent)
		expect(output.exclusions).toEqual([{ step: { kind: "event", eventName: "support_opened" } }])
		const text = markdown(result)
		expect(text).toContain("Without: support_opened between steps 1 and 2")
		// The breakdown it suggests is the same funnel, exclusions included.
		expect(text).toMatch(
			/query_funnel [^\n]*exclusions_json=[^\n]*support_opened[^\n]*breakdown_by="utmSource"/,
		)
	})

	it("leaves out the details an exclusion makes unavailable, and says so", async () => {
		const result = await call("query_funnel", {
			steps_json: steps,
			exclusions_json: exclusions,
			details: true,
		})
		const text = markdown(result)
		// The note names the section; the section itself is not there.
		expect(text).not.toContain("### Time to convert")
		expect(text).toContain("are not reported with exclusions")
	})

	it("rejects an exclusion that is not between two steps, naming the parameter", async () => {
		const result = await call("query_funnel", {
			steps_json: steps,
			exclusions_json: JSON.stringify([
				{ step: { kind: "event", eventName: "support_opened" }, after: 2, before: 2 },
			]),
		})
		expect(result.isError).toBe(true)
		const text = markdown(result)
		expect(text).toContain("`exclusions_json`")
		expect(text).toContain("after < before")
	})

	it("rejects an exclusion that is a step inside its own range, and takes one that is a bound", async () => {
		const three = JSON.stringify([
			{ kind: "page", pagePath: "/pricing" },
			{ kind: "event", eventName: "trial_started" },
			{ kind: "event", eventName: "signup_completed" },
		])
		const inside = await call("query_funnel", {
			steps_json: three,
			exclusions_json: JSON.stringify([{ step: { kind: "event", eventName: "trial_started" } }]),
		})
		expect(inside.isError).toBe(true)
		expect(markdown(inside)).toContain("`exclusions_json`")
		// "No signup before the trial": the final signup is past the range, so it still counts.
		const bound = await call("query_funnel", {
			steps_json: three,
			exclusions_json: JSON.stringify([
				{ step: { kind: "event", eventName: "signup_completed" }, after: 1, before: 2 },
			]),
		})
		expect(bound.isError).toBeUndefined()
	})

	it("does not offer to pin a funnel whose exclusions a dashboard widget would drop", async () => {
		const result = await call("query_funnel", { steps_json: steps, exclusions_json: exclusions })
		const text = markdown(result)
		expect(text).not.toContain("Pin this funnel")
		expect(text).toContain("does not take exclusions yet")
	})

	it("rejects an exclusion with no event name", async () => {
		const result = await call("query_funnel", {
			steps_json: steps,
			exclusions_json: JSON.stringify([{ step: { kind: "event", eventName: " " } }]),
		})
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("no event name or page path")
	})

	it("rejects an exclusion on a one-step funnel", async () => {
		const result = await call("query_funnel", {
			steps_json: JSON.stringify([{ kind: "event", eventName: "signup_completed" }]),
			exclusions_json: exclusions,
		})
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("needs at least two")
	})
})

describe("list_product_events output", () => {
	it("decodes with its output schema and suggests a funnel over the custom events", async () => {
		const result = await call("list_product_events", {})
		const output = Schema.decodeUnknownSync(ListProductEventsOutput)(result.structuredContent)
		expect(output.events[0]?.eventName).toBe("signup_completed")
		const text = markdown(result)
		expect(text).toContain("| signup_completed | custom |")
		expect(text).toContain("`query_funnel steps_json=")
	})

	it("points out an event that carries an account and no person, and how to count it", async () => {
		const result = await call("list_product_events", {})
		const output = Schema.decodeUnknownSync(ListProductEventsOutput)(result.structuredContent)
		expect(output.events[1]).toMatchObject({ eventName: "plan_started", persons: 0, groups: 6 })
		const text = markdown(result)
		expect(text).toContain("| plan_started | custom | 6 | 0 | 0 | 6 |")
		expect(text).toContain("`plan_started` carries a group (account) id and no user or visitor id")
		expect(text).toContain('key_by="group"')
		// An event people did is not called account-only.
		expect(text).not.toContain("`signup_completed` carries")
	})

	it("says when every event collapses onto one person", async () => {
		const result = await call("list_product_events", { host: "collapsed.test" })
		expect(markdown(result)).toContain("carry no VisitorId or UserId")
		const healthy = await call("list_product_events", {})
		expect(markdown(healthy)).not.toContain("carry no VisitorId")
	})

	it("rejects an unknown kind as a parameter error", async () => {
		const result = await call("list_product_events", { kind: "pageview" })
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("`kind`")
	})
})

describe("productEventsFunnel (observability helper)", () => {
	const rows: ReadonlyArray<{ step: number; count: number }> = [
		{ step: 1, count: 100 },
		{ step: 2, count: 40 },
	]
	const compiledSql: string[] = []
	const executor = Context.make(WarehouseExecutor, {
		orgId: Schema.decodeSync(OrgId)("org_test"),
		query: () => Effect.succeed({ data: [] }),
		compiledQuery: <T>(compiled: CH.CompiledQueryInput<T>) => {
			compiledSql.push(compiledQueryOf(compiled).sql)
			// SAFETY: the stub answers every compiled query with funnel rows; the
			// only query these tests compile is the funnel, whose row type is `T`.
			return Effect.succeed(rows as ReadonlyArray<T>)
		},
		compiledQueryFirst: () => Effect.succeedNone,
	})

	it.effect("compiles a definition and returns the executor's rows", () =>
		Effect.gen(function* () {
			const result = yield* productEventsFunnel({
				startTime: "2026-08-10 00:00:00",
				endTime: "2026-08-17 00:00:00",
				steps: [
					{ kind: "page", pagePath: "/pricing" },
					{ kind: "event", eventName: "signup_completed" },
				],
				keyBy: "person",
				windowSeconds: 86400,
			}).pipe(Effect.provide(executor))
			expect(result).toEqual(rows)
			expect(isFunnelRead(compiledSql.at(-1) ?? "")).toBe(true)
		}),
	)

	it.effect("surfaces a builder rejection as ProductEventsFunnelError, not a defect", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				productEventsFunnel({
					startTime: "2026-08-10 00:00:00",
					endTime: "2026-08-17 00:00:00",
					steps: [
						{ kind: "event", eventName: "signup_completed" },
						{ kind: "session", dimension: "country", value: "DE" },
					],
					keyBy: "person",
					windowSeconds: 86400,
				}).pipe(Effect.provide(executor)),
			)
			expect(exit._tag).toBe("Failure")
			const failed = yield* Effect.flip(
				productEventsFunnel({
					startTime: "2026-08-10 00:00:00",
					endTime: "2026-08-17 00:00:00",
					steps: [],
					keyBy: "person",
					windowSeconds: 86400,
				}).pipe(Effect.provide(executor)),
			)
			expect(failed).toBeInstanceOf(CH.ProductEventsFunnelError)
			expect(failed).toHaveProperty("reason", "NoSteps")
		}),
	)
})
