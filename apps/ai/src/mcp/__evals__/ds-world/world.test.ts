import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Array as Arr, Effect } from "effect"
import { ExternalDataSourceService } from "@maple/backend/services/data-sources/ExternalDataSourceService"
import { makeEvalRuntime, type EvalRuntime } from "../eval-runtime"
import { EVAL_TENANT } from "../utils"
import { prodSignupsWithin } from "./clerk-users"
import { dataSourceWorldLayer, makeDataSourceWorldState, seedDataSourceWorld } from "./runtime"

const DAY_MS = 86_400_000
const orgId = EVAL_TENANT.orgId
const agent = { agent: true }
const now = Date.now()
// ClickHouse is off here: catalogs and Clerk work without Docker; SQL gets a connection error.
const state = makeDataSourceWorldState(now, false)

let rt: EvalRuntime
const run = <A, E>(f: (service: ExternalDataSourceService["Service"]) => Effect.Effect<A, E>) =>
	rt.runtime.runPromise(Effect.flatMap(Effect.service(ExternalDataSourceService), f))

beforeAll(async () => {
	rt = makeEvalRuntime(undefined, dataSourceWorldLayer(state))
	await rt.runtime.runPromise(seedDataSourceWorld)
}, 60_000)
afterAll(() => rt.dispose())

describe("data source world", () => {
	it("holds 18 sources and hides the payroll source from agents", async () => {
		const all = await run((s) => s.list(orgId, { agent: false }))
		const visible = await run((s) => s.list(orgId, agent))
		expect(all).toHaveLength(18)
		expect(Arr.map(visible, (source) => source.name)).not.toContain("people-ops")
		expect(visible).toHaveLength(17)
		const hits = await run((s) => s.search(orgId, "payroll salary", agent))
		expect(Arr.map(hits, (hit) => hit.source)).not.toContain("people-ops")
	})

	it("stores the legacy warehouse's 400 tables", async () => {
		const legacy = await run((s) => s.get(orgId, "warehouse-legacy", agent))
		expect(legacy.catalogEntryCount).toBe(400)
	})

	it("ranks billing first for invoices", async () => {
		const hits = await run((s) => s.search(orgId, "invoices", agent))
		expect(hits[0]).toMatchObject({ source: "billing", entry: "billing.invoices" })
	})

	it("counts this week's production signups through the Clerk driver", async () => {
		const result = await run((s) =>
			s.query(
				orgId,
				"clerk-prod",
				{ _tag: "resource", resource: "users", measure: { fn: "count" } },
				{ startMs: now - 7 * DAY_MS, endMs: now, workload: "interactive" },
				agent,
			),
		)
		expect(result.rows).toEqual([{ count: prodSignupsWithin(7) }])
		expect(state.clerkProd.calls.length).toBeGreaterThan(0)
	})

	it("refuses SQL with a connection error while ClickHouse is off", async () => {
		const exit = await rt.runtime.runPromiseExit(
			Effect.flatMap(Effect.service(ExternalDataSourceService), (s) =>
				s.query(
					orgId,
					"shop-prod",
					{ _tag: "sql", sql: "SELECT count() FROM shop.payments" },
					{ startMs: now - DAY_MS, endMs: now, workload: "interactive" },
					agent,
				),
			),
		)
		expect(JSON.stringify(exit)).toContain("refused the connection")
	})
})
