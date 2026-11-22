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
		rows: [{ eventName: "page_view", kind: "navigation", count: 40, sessions: 12, persons: 1 }],
	},
	// The breakdown read names the attribute it groups by.
	{
		match: (sql) => isFunnelRead(sql) && Str.includes("'plan'")(sql),
		rows: [{ group: "pro", step: 1, count: 10 }],
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
		rows: [{ eventName: "signup_completed", kind: "custom", count: 12, sessions: 10, persons: 9 }],
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
