import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Context, Effect, Option, Schema } from "effect"
import { WarehouseExecutor, productEventsFunnel } from "@maple/query-engine/observability"
import { CH } from "@maple/query-engine"
import { ListProductEventsOutput, QueryFunnelOutput } from "@maple/domain/mcp-outputs"
import type { McpToolResult } from "../types"
import { mapleToolCatalog, toInputSchema } from "../registry"
import { compiledQueryOf } from "@maple/query-engine/execution"
import { installFakeWarehouse, restoreWarehouse, type FixtureRule } from "../../__evals__/fake-warehouse"
import { makeEvalRuntime, markdown, runToolDirect, type EvalRuntime } from "../../__evals__/eval-runtime"

// Both tools run through the registry the way a client reaches them, against a fake warehouse
// that answers the funnel read with two steps and the event-name read with one custom event.
const fixtures: FixtureRule[] = [
	// The breakdown read names the attribute it groups by.
	{
		match: (sql) => /windowFunnel/i.test(sql) && sql.includes("'plan'"),
		rows: [{ group: "pro", step: 1, count: 10 }],
	},
	{
		match: (sql) => /windowFunnel/i.test(sql),
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

describe("query_funnel / list_product_events registration", () => {
	it("both tools are in the catalog with object input schemas", () => {
		for (const name of ["query_funnel", "list_product_events"]) {
			const definition = mapleToolCatalog.find((d) => d.name === name)
			expect(definition, name).toBeDefined()
			expect(toInputSchema(definition!.schema).type).toBe("object")
		}
	})

	it("query_funnel requires steps_json and nothing else", () => {
		const definition = mapleToolCatalog.find((d) => d.name === "query_funnel")!
		expect(toInputSchema(definition.schema).required).toEqual(["steps_json"])
	})

	it("list_product_events has only optional parameters", () => {
		const definition = mapleToolCatalog.find((d) => d.name === "list_product_events")!
		expect(toInputSchema(definition.schema).required ?? []).toEqual([])
	})
})

describe("query_funnel validation", () => {
	it("rejects malformed steps_json as a parameter error", async () => {
		const result = await call("query_funnel", { steps_json: "not json" })
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain("Invalid parameters for `query_funnel`")
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
		expect(markdown(good)).toContain("### By attribute:plan")
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
		expect(output.steps.map((step) => step.count)).toEqual([100, 40])
		expect(output.conversion).toBeCloseTo(0.4)
		expect(output.definition).toEqual(steps)
		const text = markdown(result)
		expect(text).toContain("## Funnel (2 steps, by person")
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
		orgId: "org_test",
		query: () => Effect.succeed({ data: [] }),
		compiledQuery: <T>(compiled: { readonly sql: string }) => {
			compiledSql.push(compiledQueryOf(compiled).sql)
			// SAFETY: the stub answers every compiled query with funnel rows; the
			// only query these tests compile is the funnel, whose row type is `T`.
			return Effect.succeed(rows as ReadonlyArray<T>)
		},
		compiledQueryFirst: () => Effect.succeed(Option.none()),
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
			expect(compiledSql.at(-1)).toContain("windowFunnel")
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
			expect((failed as CH.ProductEventsFunnelError).reason).toBe("NoSteps")
		}),
	)
})
