/**
 * `run_sql` failures an agent hit in production, replayed against the real tool: the column
 * names it fixes by itself and the internal SQL it keeps out of the error.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Schema } from "effect"
import { RunSqlOutput } from "@maple/domain/mcp-outputs"
import { makeEvalRuntime, runToolDirect, markdown, type EvalRuntime } from "./eval-runtime"
import { installFakeWarehouse, restoreWarehouse } from "./fake-warehouse"

const unknown = (name: string) => ({
	message: `[Error] Unknown expression or function identifier \`${name}\` in scope SELECT ${name} FROM traces`,
	type: "UNKNOWN_IDENTIFIER",
})

const GATEWAY_WRAPPED = {
	message:
		"[Error] Unknown expression identifier `Level` in scope SELECT Level FROM (SELECT * FROM (SELECT * FROM " +
		"maple_us.alert_checks WHERE OrgId = 'org_x') AS maple_us.alert_checks WHERE OrgId = 'org_x') AS alert_checks " +
		"WHERE (OrgId = 'org_x') ) AS maple_raw_sql_limited LIMIT 1001 SETTINGS max_execution_time=10",
	type: "UNKNOWN_IDENTIFIER",
}

let rt: EvalRuntime

beforeAll(() => {
	installFakeWarehouse([
		{ match: (sql) => sql.includes("service.name"), failure: unknown("service.name") },
		{ match: (sql) => sql.includes("FROM alert_checks"), failure: GATEWAY_WRAPPED },
		{ match: (sql) => /\bbogus\b/.test(sql), failure: unknown("bogus") },
		// Every pass fixes one name and the warehouse names the next one.
		{ match: (sql) => sql.includes("trace_id"), failure: unknown("trace_id") },
		{ match: (sql) => sql.includes("span_id"), failure: unknown("span_id") },
		{ match: (sql) => sql.includes("span_name"), failure: unknown("span_name") },
		{ match: (sql) => sql.includes("status_code"), failure: unknown("status_code") },
		{ match: (sql) => sql.includes("ServiceName"), rows: [{ ServiceName: "checkout", c: 3 }] },
	])
	rt = makeEvalRuntime()
})

afterAll(async () => {
	restoreWarehouse()
	await rt.dispose()
})

const WINDOW = { start_time: "2026-09-24 00:00:00", end_time: "2026-09-24 06:00:00" }

describe("run_sql recovery", () => {
	it("reruns a misspelt column with its one right name and says so", async () => {
		const result = await runToolDirect(rt, "run_sql", {
			...WINDOW,
			sql: "SELECT service.name, count() AS c FROM traces WHERE $__orgFilter AND service.name != '' GROUP BY service.name",
		})
		expect(result.isError).not.toBe(true)
		const output = Schema.decodeUnknownSync(RunSqlOutput)(result.structuredContent)
		expect(output.rows).toEqual([{ ServiceName: "checkout", c: 3 }])
		expect(output.rewrites).toEqual([{ from: "service.name", to: "ServiceName" }])
		expect(markdown(result)).toContain("Ran with `ServiceName` for `service.name`")
	})

	it("says which rewrite the error belongs to when the rerun fails on another name", async () => {
		const result = await runToolDirect(rt, "run_sql", {
			...WINDOW,
			sql: "SELECT service.name, bogus FROM traces WHERE $__orgFilter",
		})
		expect(result.isError).toBe(true)
		const text = markdown(result)
		expect(text).toContain("`bogus`")
		expect(text).toContain("This error is for the query rerun with `ServiceName` for `service.name`.")
	})

	it("stops rewriting after three passes", async () => {
		const result = await runToolDirect(rt, "run_sql", {
			...WINDOW,
			sql: "SELECT trace_id, span_id, span_name, status_code FROM traces WHERE $__orgFilter",
		})
		expect(result.isError).toBe(true)
		const text = markdown(result)
		expect(text).toContain("`status_code`")
		expect(text).toContain("`TraceId` for `trace_id`, `SpanId` for `span_id`, `SpanName` for `span_name`")
	})

	it("keeps the gateway's internal database names out of the error", async () => {
		const result = await runToolDirect(rt, "run_sql", {
			...WINDOW,
			sql: "SELECT Level FROM alert_checks WHERE $__orgFilter",
		})
		const text = markdown(result)
		expect(text).toContain("FROM alert_checks")
		expect(text).not.toContain("maple_us")
		expect(text).not.toContain("maple_raw_sql_limited")
		expect(text).not.toContain("org_x")
	})
})
