import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Array as Arr, String as Str } from "effect"
import type { RetentionOverrides } from "@maple/domain/retention"
import { RetentionService } from "@maple/backend/services/retention/RetentionService"
import { installFakeWarehouse, restoreWarehouse, type FixtureRule } from "../../__evals__/fake-warehouse"
import { makeEvalRuntime, markdown, runToolDirect, type EvalRuntime } from "../../__evals__/eval-runtime"
import { FIXTURES } from "../../__evals__/utils"

// The tools that look back a fixed 30 days by default follow the org's retention instead. They
// run through the registry against a warehouse that holds nothing, so every lookup probes as far
// back as it is going to.

const DAY_MS = 86_400_000

/** Every statement a call issued. */
const issued: Array<string> = []
const fixtures: FixtureRule[] = [
	{
		match: (sql) => {
			issued.push(sql)
			return false
		},
		rows: [],
	},
]

let rt: EvalRuntime
const call = (name: string, params: Record<string, unknown>) => {
	issued.length = 0
	return runToolDirect(rt, name, params)
}
const setRetention = (overrides: RetentionOverrides) =>
	rt.runtime.runPromise(
		RetentionService.use((retention) =>
			retention.setOrganization(rt.tenant.orgId, rt.tenant.userId, overrides),
		),
	)

const PROBE_START = /Bucket >= toStartOfFiveMinutes\(toDateTime64\('([^']+)'/

/** How many days before now the oldest `trace_index` probe of the last call starts. */
const oldestProbeDays = (): number => {
	const starts = Arr.flatMap(issued, (sql) => {
		const start = Str.includes("FROM trace_index")(sql) ? PROBE_START.exec(sql)?.[1] : undefined
		return start === undefined ? [] : [Date.parse(`${Str.replace(" ", "T")(start)}Z`)]
	})
	return Math.round((Date.now() - Math.min(...starts)) / DAY_MS)
}

beforeAll(() => {
	installFakeWarehouse(fixtures, undefined, "empty")
	rt = makeEvalRuntime()
})
afterAll(async () => {
	restoreWarehouse()
	await rt.dispose()
})

describe("trace lookups", () => {
	it("look back the default 30 days for an org that set no period", async () => {
		await setRetention({})
		await call("inspect_trace", { trace_id: FIXTURES.traceId })
		expect(oldestProbeDays()).toBe(30)
		await call("inspect_span", { trace_id: FIXTURES.traceId, span_id: FIXTURES.spanId })
		expect(oldestProbeDays()).toBe(30)
	})

	it("reach as far back as an org that keeps traces longer", async () => {
		await setRetention({ traces: 90 })
		await call("inspect_trace", { trace_id: FIXTURES.traceId })
		expect(oldestProbeDays()).toBe(90)
		await call("inspect_span", { trace_id: FIXTURES.traceId, span_id: FIXTURES.spanId })
		expect(oldestProbeDays()).toBe(90)
	})

	it("stop where an org that keeps traces for less stops", async () => {
		await setRetention({ traces: 3 })
		await call("inspect_trace", { trace_id: FIXTURES.traceId })
		expect(oldestProbeDays()).toBe(3)
		await call("inspect_span", { trace_id: FIXTURES.traceId, span_id: FIXTURES.spanId })
		expect(oldestProbeDays()).toBe(3)
	})
})

describe("the session retention note", () => {
	const steps = JSON.stringify([
		{ kind: "event", eventName: "signup_started" },
		{ kind: "event", eventName: "signup_done" },
	])
	const daysAgo = (days: number) =>
		Str.replace("T", " ")(Str.slice(0, 19)(new Date(Date.now() - days * DAY_MS).toISOString()))
	const funnelFrom = async (days: number) =>
		markdown(await call("query_funnel", { steps_json: steps, start_time: daysAgo(days), country: "DE" }))

	it("stays quiet inside the period, for an org that changed another signal's", async () => {
		await setRetention({ traces: 90 })
		expect(await funnelFrom(20)).not.toContain("Sessions are kept")
		expect(await funnelFrom(60)).toContain("Sessions are kept 30 days")
	})

	it("says 30 days for an org that set no period", async () => {
		await setRetention({})
		expect(await funnelFrom(60)).toContain("Sessions are kept 30 days")
	})
})
