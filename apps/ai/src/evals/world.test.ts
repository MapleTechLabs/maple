/**
 * The eval world, through the real tools. Rules route by the compiled SQL's shape, so a query
 * change can leave the world silently empty, and an empty world makes the tool tasks unfair
 * again. This fails first.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { makeEvalRuntime, markdown, runToolDirect, type EvalRuntime } from "../mcp/__evals__/eval-runtime"
import { installFakeWarehouse, restoreWarehouse } from "../mcp/__evals__/fake-warehouse"
import { FIXTURES } from "../mcp/__evals__/utils"
import { seedWorld, WORLD_SERVICES, worldRules } from "./world"

let rt: EvalRuntime

beforeAll(async () => {
	installFakeWarehouse(worldRules(), undefined, "empty")
	rt = makeEvalRuntime()
	await seedWorld(rt)
})

afterAll(async () => {
	restoreWarehouse()
	await rt.dispose()
})

const render = async (name: string, params: unknown) => markdown(await runToolDirect(rt, name, params))

describe("eval world", () => {
	it("lists every world service", async () => {
		const text = await render("list_services", {})
		WORLD_SERVICES.forEach((service) => expect(text).toContain(`| ${service.name} |`))
	})

	it("reads as freshly ingesting", async () => {
		expect(await render("ingest_freshness", {})).toMatch(/\| traces \| receiving \|/)
	})

	it("has the attribute keys and values the tasks name", async () => {
		expect(await render("explore_attributes", { source: "traces" })).toContain("| applicationId |")
		expect(await render("explore_attributes", { source: "traces", key: "applicationId" })).toContain(
			"| 16408 |",
		)
	})

	it("scopes errors and operations to the service asked about", async () => {
		const errors = await render("find_errors", { service: "checkout" })
		expect(errors).toContain(FIXTURES.fingerprint)
		expect(errors).not.toContain("ConnectionResetError")
		expect(await render("get_service_top_operations", { service: "consumer-stripe-v2" })).toContain(
			"| processStripeV2 |",
		)
	})

	it("runs raw SQL against the world instead of failing on configuration", async () => {
		const text = await render("run_sql", {
			sql: "SELECT ServiceName, count() AS spans FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp) GROUP BY ServiceName",
		})
		expect(text).toContain("## SQL result")
	})

	it("has the error issue and error detail the issue tasks name", async () => {
		const issue = await render("error_detail", { issue_id: FIXTURES.issueId })
		expect(issue).toContain("TimeoutError")
		expect(issue).not.toContain("Query failed")
		const events = await render("list_error_issue_events", { issue_id: FIXTURES.issueId })
		expect(events).not.toContain("not found")
		expect(await render("error_detail", { fingerprint: FIXTURES.fingerprint })).toContain(
			"checkout timeout",
		)
	})

	it("answers traces breakdowns by service and by operation", async () => {
		const byService = await render("query_data", {
			source: "traces",
			kind: "breakdown",
			metric: "error_rate",
			group_by: "service",
		})
		expect(byService).toContain("consumer-app-store-connect")
		const byOperation = await render("query_data", {
			source: "traces",
			kind: "breakdown",
			metric: "p95_duration",
			group_by: "span_name",
			service: "subscriptions-api",
		})
		expect(byOperation).toContain("PublicApiKeyAuthn")
		expect(byOperation).not.toContain("GET /api/checkout")
	})
})
