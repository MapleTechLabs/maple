/**
 * `run_sql` failures an agent hit in production, replayed against the real tool: the column
 * names it fixes by itself and the internal SQL it keeps out of the error.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Schema, Array as Arr, String as Str } from "effect"
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

const SYNTAX = {
	message: "DB::Exception: Syntax error: failed at position 39 (FROM) (line 2, col 23): FROM logs",
	type: "SYNTAX_ERROR",
}

const FALLBACK_ID = "aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb"
const issued: Array<string> = []
let rt: EvalRuntime

beforeAll(() => {
	installFakeWarehouse([
		// Records every statement and matches none of them.
		{
			match: (sql) => {
				issued.push(sql)
				return false
			},
			rows: [],
		},
		{
			match: (sql) => Str.includes(FALLBACK_ID)(sql) && Str.includes("FROM trace_index")(sql),
			failure: unknown("ServiceName"),
		},
		{ match: (sql) => Str.includes(FALLBACK_ID)(sql), rows: [{ n: 1 }] },
		// Sizes attribute scans: 900M spans over the six-day window, 10M over two hours.
		{
			match: (sql) => /\bFROM service_usage\b/.test(sql),
			rows: (sql) => [
				{
					serviceName: "big",
					spanCount: Str.includes("2026-09-18")(sql) ? 900_000_000 : 10_000_000,
					firstHourSpanCount: 0,
					lastHourSpanCount: 0,
				},
			],
		},
		{ match: (sql) => /\bany\(Body\) sample\b/.test(sql), failure: SYNTAX },
		{ match: (sql) => Str.includes("`sample`")(sql), rows: [{ n: 2, sample: "x" }] },
		{ match: (sql) => Str.includes("EXCEPT (DurationQuantiles)")(sql), rows: [{ SpanName: "op" }] },
		{ match: (sql) => /\(SeverityNumber >= 17 OR Body ILIKE/.test(sql), rows: [{ n: 3 }] },
		{ match: (sql) => Str.includes("SpanAttributes['k']")(sql), rows: [{ n: 4 }] },
		{
			match: (sql) => Str.includes("FROM product_events")(sql),
			rows: Array.from({ length: 1000 }, (_, i) => ({ n: i })),
		},
		{ match: (sql) => Str.includes("service.name")(sql), failure: unknown("service.name") },
		{ match: (sql) => Str.includes("FROM alert_checks")(sql), failure: GATEWAY_WRAPPED },
		{ match: (sql) => /\bbogus\b/.test(sql), failure: unknown("bogus") },
		// Every pass fixes one name and the warehouse names the next one.
		{ match: (sql) => Str.includes("trace_id")(sql), failure: unknown("trace_id") },
		{ match: (sql) => Str.includes("span_id")(sql), failure: unknown("span_id") },
		{ match: (sql) => Str.includes("span_name")(sql), failure: unknown("span_name") },
		{ match: (sql) => Str.includes("status_code")(sql), failure: unknown("status_code") },
		{ match: (sql) => Str.includes("ServiceName")(sql), rows: [{ ServiceName: "checkout", c: 3 }] },
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

	it("stops at the row cap instead of failing on a longer result", async () => {
		const result = await runToolDirect(rt, "run_sql", {
			...WINDOW,
			sql: "SELECT number AS n FROM product_events WHERE $__orgFilter",
		})
		expect(result.isError).not.toBe(true)
		expect(issued.at(-1)).toMatch(/LIMIT 1000\b/)
		const output = Schema.decodeUnknownSync(RunSqlOutput)(result.structuredContent)
		expect(output.rowCount).toBe(1000)
		expect(output.atRowCap).toBe(true)
		expect(markdown(result)).toContain("Stopped at the 1000-row cap")
	})

	it("trusts a full page the query's own LIMIT asked for", async () => {
		const result = await runToolDirect(rt, "run_sql", {
			...WINDOW,
			sql: "SELECT number AS n FROM product_events WHERE $__orgFilter LIMIT 1000",
		})
		const output = Schema.decodeUnknownSync(RunSqlOutput)(result.structuredContent)
		expect(output.rowCount).toBe(1000)
		expect(output.atRowCap).toBeUndefined()
		expect(markdown(result)).not.toContain("row cap")
	})

	it("reads the count, not the offset, of LIMIT offset, count", async () => {
		const result = await runToolDirect(rt, "run_sql", {
			...WINDOW,
			sql: "SELECT number AS n FROM product_events WHERE $__orgFilter LIMIT 10, 5000",
		})
		expect(Schema.decodeUnknownSync(RunSqlOutput)(result.structuredContent).atRowCap).toBe(true)
	})

	// The seek names `ServiceName`/`Timestamp`, which an outer query over a subquery may lack.
	it("runs a trace-id lookup as written when the warehouse cannot analyse the seeked form", async () => {
		const result = await runToolDirect(rt, "run_sql", {
			...WINDOW,
			sql: `SELECT count() AS n FROM (SELECT TraceId FROM traces WHERE $__orgFilter) WHERE TraceId = '${FALLBACK_ID}'`,
		})
		expect(result.isError).not.toBe(true)
		expect(Schema.decodeUnknownSync(RunSqlOutput)(result.structuredContent).rows).toEqual([{ n: 1 }])
		const lookups = Arr.filter(issued, (sql) => Str.includes(FALLBACK_ID)(sql))
		expect(lookups).toHaveLength(2)
		expect(lookups[0]).toContain("FROM trace_index")
		expect(lookups[1]).not.toContain("FROM trace_index")
	})

	it("reruns with a keyword alias quoted", async () => {
		const result = await runToolDirect(rt, "run_sql", {
			...WINDOW,
			sql: "SELECT count() n, any(Body) sample FROM logs WHERE $__orgFilter",
		})
		expect(result.isError).not.toBe(true)
		const output = Schema.decodeUnknownSync(RunSqlOutput)(result.structuredContent)
		expect(output.rows).toEqual([{ n: 2, sample: "x" }])
		expect(markdown(result)).toContain(
			"Ran with `AS `sample`` for `sample`: a keyword is an alias only after AS.",
		)
	})

	it("parenthesises an OR beside the org filter and runs it", async () => {
		const result = await runToolDirect(rt, "run_sql", {
			...WINDOW,
			sql: "SELECT count() AS n FROM logs WHERE $__orgFilter AND SeverityNumber >= 17 OR Body ILIKE '%error%'",
		})
		expect(result.isError).not.toBe(true)
		expect(Schema.decodeUnknownSync(RunSqlOutput)(result.structuredContent).rows).toEqual([{ n: 3 }])
	})

	it("leaves aggregate states out of SELECT * before the first run", async () => {
		const result = await runToolDirect(rt, "run_sql", {
			...WINDOW,
			sql: "SELECT * FROM service_operations_hourly WHERE $__orgFilter LIMIT 5",
		})
		expect(result.isError).not.toBe(true)
		expect(Arr.some(issued, (sql) => /SELECT \* FROM service_operations_hourly/.test(sql))).toBe(false)
	})

	it("refuses an attribute scan too large for the time limit, naming a window that fits", async () => {
		const before = issued.length
		const result = await runToolDirect(rt, "run_sql", {
			start_time: "2026-09-18 00:00:00",
			end_time: "2026-09-24 00:00:00",
			sql: "SELECT count() AS n FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp) AND SpanAttributes['k'] LIKE '%x%'",
		})
		expect(result.isError).toBe(true)
		const text = markdown(result)
		expect(text).toContain("about 900M spans across every service")
		expect(text).toContain("Narrow the window to 4 hours or less (e.g. start_time='2026-09-23 20:00:00'")
		// Only the estimate ran, never the scan.
		expect(Arr.some(issued.slice(before), (sql) => Str.includes("SpanAttributes['k']")(sql))).toBe(false)
	})

	it("runs the same scan over a window that fits", async () => {
		const result = await runToolDirect(rt, "run_sql", {
			start_time: "2026-09-23 22:00:00",
			end_time: "2026-09-24 00:00:00",
			sql: "SELECT count() AS n FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp) AND SpanAttributes['k'] LIKE '%x%'",
		})
		expect(result.isError).not.toBe(true)
		expect(Schema.decodeUnknownSync(RunSqlOutput)(result.structuredContent).rows).toEqual([{ n: 4 }])
	})
})
