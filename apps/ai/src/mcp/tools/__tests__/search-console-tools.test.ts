import { afterAll, beforeAll, beforeEach, describe, expect, it } from "@effect/vitest"
import { Schema, String as Str } from "effect"
import {
	DescribeWarehouseTablesOutput,
	ListIntegrationsOutput,
	RunSqlOutput,
	SearchConsolePagesOutput,
	SearchConsoleQueriesOutput,
} from "@maple/domain/mcp-outputs"
import { executeSql } from "@maple/backend/platform/test-pglite"
import { addDays, pacificToday } from "@maple/domain/search-console"
import type { McpToolResult } from "../types"
import { installFakeWarehouse, restoreWarehouse, type FixtureRule } from "../../__evals__/fake-warehouse"
import { makeEvalRuntime, markdown, runToolDirect, type EvalRuntime } from "../../__evals__/eval-runtime"
import { FIXTURES } from "../../__evals__/utils"
import { queryTrendSql, totalsFields } from "../search-console-queries"

const SITE = "sc-domain:acme.dev"
const OTHER_SITE = "https://blog.acme.dev/"
const sqlSeen: string[] = []

const readsSearch = (sql: string, grain: string) =>
	Str.includes("search_console_daily")(sql) && Str.includes(`'${grain}'`)(sql)

const fixtures: FixtureRule[] = [
	{
		match: (sql) => (Str.includes("previousClicks")(sql) ? (sqlSeen.push(sql), true) : false),
		rows: [
			{
				clicks: 1200,
				impressions: 60000,
				ctr: 0.02,
				position: 8.4,
				previousClicks: 1000,
				previousImpressions: 50000,
				previousCtr: 0.02,
				previousPosition: 9.1,
			},
		],
	},
	{
		match: (sql) => (readsSearch(sql, "query") ? (sqlSeen.push(sql), true) : false),
		rows: [
			{ query: "acme pricing", clicks: 300, impressions: 4000, ctr: 0.075, position: 2.1 },
			{ query: "acme o'reilly review", clicks: 120, impressions: 9000, ctr: 0.013, position: 6.5 },
		],
	},
	{
		match: (sql) => (readsSearch(sql, "page") ? (sqlSeen.push(sql), true) : false),
		rows: [
			{
				page: "https://acme.dev/pricing",
				clicks: 500,
				impressions: 8000,
				positionSum: 24000,
				ctr: 0.0625,
				position: 3,
			},
			{
				page: "https://acme.dev/docs/",
				clicks: 80,
				impressions: 20000,
				positionSum: 160000,
				ctr: 0.004,
				position: 8,
			},
		],
	},
	// run_sql on the site grain: nothing imported, as an org on its own ClickHouse would see.
	{
		match: (sql) => (readsSearch(sql, "site") ? (sqlSeen.push(sql), true) : false),
		rows: [],
	},
	{
		match: (sql) => (Str.includes("EntryPath")(sql) ? (sqlSeen.push(sql), true) : false),
		rows: (sql) =>
			Str.includes("signup")(sql)
				? [
						{
							host: "acme.dev",
							entryPath: "/pricing",
							sessions: 40,
							bouncedSessions: 0,
							identifiedSessions: 40,
						},
					]
				: [
						{
							host: "acme.dev",
							entryPath: "/pricing",
							sessions: 400,
							bouncedSessions: 100,
							identifiedSessions: 400,
						},
						{
							host: "acme.dev",
							entryPath: "/docs",
							sessions: 60,
							bouncedSessions: 54,
							identifiedSessions: 60,
						},
					],
	},
]

let rt: EvalRuntime

const sql = (text: string, params: ReadonlyArray<unknown> = []) => executeSql(rt.testDb, text, [...params])

const connectGoogle = (revoked = false) =>
	sql(
		`INSERT INTO oauth_connections (id, org_id, provider, external_user_id, external_account_name,
			connected_by_user_id, access_token_ciphertext, access_token_iv, access_token_tag, created_at, updated_at, revoked_at)
		 VALUES ('oauth_google', $1, 'google', 'google-user', 'Acme', 'user_eval', 'c', 'i', 't', now(), now(), $2)`,
		[FIXTURES.orgId, revoked ? new Date().toISOString() : null],
	)

const addSite = (id: string, siteUrl: string, watermark: string | null, lastError: string | null = null) =>
	sql(
		`INSERT INTO search_console_sites (id, org_id, oauth_connection_id, site_url, permission_level, enabled,
			watermark_date, last_synced_at, last_error, created_at, updated_at)
		 VALUES ($1, $2, 'oauth_google', $3, 'siteOwner', true, $4, now(), $5, now(), now())`,
		[id, FIXTURES.orgId, siteUrl, watermark, lastError],
	)

const call = (name: string, params: Record<string, unknown>): Promise<McpToolResult> =>
	runToolDirect(rt, name, params)

beforeAll(() => {
	installFakeWarehouse(fixtures)
	rt = makeEvalRuntime()
})

afterAll(async () => {
	restoreWarehouse()
	await rt.dispose()
})

beforeEach(async () => {
	await sql("DELETE FROM search_console_sites")
	await sql("DELETE FROM oauth_connections")
	sqlSeen.length = 0
})

describe("search console tools before data exists", () => {
	it("is unavailable when Google is not connected or the grant was revoked", async () => {
		const missing = await call("search_console_queries", {})
		expect(missing.isError).toBe(true)
		expect(missing.failureCategory).toBe("unavailable")
		// The eval deployment has no Google OAuth client, the stronger form of not connected.
		expect(markdown(missing)).toContain("cannot be connected")

		await connectGoogle(true)
		const revoked = await call("search_console_pages", {})
		expect(revoked.failureCategory).toBe("unavailable")
		expect(markdown(revoked)).toContain("revoked")
		expect(sqlSeen).toEqual([])
	})

	it("is not ready until the first import lands, quoting Google's error", async () => {
		await connectGoogle()
		await addSite(
			"2b1e0c3b-0000-4000-8000-000000000001",
			SITE,
			null,
			"403 User does not have sufficient permission",
		)
		const result = await call("search_console_queries", {})
		expect(result.isError).toBe(true)
		expect(result.failureCategory).toBe("not_ready")
		expect(markdown(result)).toContain("sufficient permission")
	})

	it("rejects a property that is not enabled, naming the enabled ones", async () => {
		await connectGoogle()
		await addSite("2b1e0c3b-0000-4000-8000-000000000001", SITE, "2026-10-28")
		const result = await call("search_console_queries", { site: "example.org" })
		expect(result.isError).toBe(true)
		expect(markdown(result)).toContain(SITE)
	})
})

describe("search_console_queries", () => {
	beforeEach(async () => {
		await connectGoogle()
		await addSite("2b1e0c3b-0000-4000-8000-000000000001", SITE, "2026-10-28")
		await addSite("2b1e0c3b-0000-4000-8000-000000000002", OTHER_SITE, "2026-10-28")
	})

	it("ends the default window on the last complete day and reports totals with deltas", async () => {
		const result = await call("search_console_queries", {
			site: "acme.dev",
			device: "mobile",
			country: "USA",
		})
		expect(result.isError).toBeUndefined()
		const output = Schema.decodeUnknownSync(SearchConsoleQueriesOutput)(result.structuredContent)
		expect(output.site.siteUrl).toBe(SITE)
		expect(output.site.otherSites).toEqual([OTHER_SITE])
		expect(output.timeRange.end).toBe("2026-10-28 23:59:59")
		expect(output.totals).toMatchObject({ clicks: 1200, previous: { clicks: 1000 } })
		expect(output.queries.map((q) => q.query)).toEqual(["acme pricing", "acme o'reilly review"])
		expect(output.country).toBe("usa")
		const querySql = sqlSeen.find((s) => readsSearch(s, "query")) ?? ""
		expect(querySql).toContain("'usa'")
		expect(querySql).toContain("'mobile'")
		expect(querySql).toContain("OrgId")

		const text = markdown(result)
		expect(text).toContain("+20.0%")
		expect(text).toContain("Totals are the whole property's")
		expect(text).toContain("`search_console_pages")
		expect(text).toContain("`run_sql")
	})

	it("says how much of an explicit window Google has not reported yet", async () => {
		const result = await call("search_console_queries", { end_time: "2026-10-31 12:00:00" })
		expect(markdown(result)).toContain("the last 3 days of this window are left out")
		// The reads themselves stop at the last complete day.
		expect(sqlSeen.find((s) => Str.includes("previousClicks")(s))).toContain("<= '2026-10-28 00:00:00'")
	})

	it("treats today's import as partial: data runs through yesterday", async () => {
		const today = pacificToday(Date.now())
		await sql("UPDATE search_console_sites SET watermark_date = $1", [today])
		const result = await call("search_console_queries", { site: SITE })
		const output = Schema.decodeUnknownSync(SearchConsoleQueriesOutput)(result.structuredContent)
		expect(output.site.dataThrough).toBe(addDays(today, -1))
		expect(output.timeRange.end).toBe(`${addDays(today, -1)} 23:59:59`)
	})
})

describe("search_console_queries totals", () => {
	const totals = (impressions: number, previous: { clicks: number; impressions: number; ctr: number }) => ({
		clicks: impressions === 0 ? 0 : 1200,
		impressions,
		ctr: impressions === 0 ? 0 : 0.02,
		position: impressions === 0 ? 0 : 8.4,
		previous: { ...previous, position: 9.1 },
	})

	it("shows each metric's change against the previous period", () => {
		expect(totalsFields(totals(60000, { clicks: 1000, impressions: 50000, ctr: 0.02 }))).toEqual([
			["Clicks", "1,200 (+20.0%)"],
			["Impressions", "60,000 (+20.0%)"],
			["CTR", "2.00% (+0.00 pp)"],
			["Avg position", "8.4 (was 9.1)"],
		])
	})

	it("shows no change at all when the period has no impressions", () => {
		expect(totalsFields(totals(0, { clicks: 1000, impressions: 50000, ctr: 0.02 }))).toEqual([
			["Clicks", "0"],
			["Impressions", "0"],
			["CTR", "0.00%"],
			["Avg position", "-"],
		])
	})

	it("leaves out a change from a previous value of 0", () => {
		expect(totalsFields(totals(60000, { clicks: 0, impressions: 0, ctr: 0 }))[0]).toEqual([
			"Clicks",
			"1,200",
		])
	})
})

describe("search_console_pages", () => {
	beforeEach(async () => {
		await connectGoogle()
		await addSite("2b1e0c3b-0000-4000-8000-000000000001", SITE, "2026-10-28")
	})

	it("joins search pages with sessions, bounce rate and conversions, in the asked order", async () => {
		const result = await call("search_console_pages", { sort: "impressions", conversion_event: "signup" })
		expect(result.isError).toBeUndefined()
		const output = Schema.decodeUnknownSync(SearchConsolePagesOutput)(result.structuredContent)
		expect(output.pages.map((p) => p.path)).toEqual(["/docs", "/pricing"])
		expect(output.pages[0]).toMatchObject({ sessions: 60, conversions: 0 })
		expect(output.pages[0]?.bounceRate).toBeCloseTo(0.9)
		expect(output.pages[1]).toMatchObject({ clicks: 500, sessions: 400, conversions: 40 })
		expect(sqlSeen.find((s) => readsSearch(s, "page"))).toContain("ORDER BY impressions DESC")

		const text = markdown(result)
		expect(text).toContain("Conversions")
		expect(text).toContain("`search_console_queries")
		expect(text).toContain('page="https://acme.dev/docs/"')
	})
})

describe("list_integrations for search console", () => {
	it("points at the search console tools", async () => {
		await connectGoogle()
		await addSite("2b1e0c3b-0000-4000-8000-000000000001", SITE, "2026-10-28")
		const result = await call("list_integrations", { provider: "search_console" })
		Schema.decodeUnknownSync(ListIntegrationsOutput)(result.structuredContent)
		const text = markdown(result)
		expect(text).toContain("`search_console_queries")
		expect(text).toContain("`search_console_pages")
	})
})

describe("search_console_daily in raw SQL", () => {
	it("is described with its grain, version and position rules", async () => {
		const result = await call("describe_warehouse_tables", { tables: ["search_console_daily"] })
		const output = Schema.decodeUnknownSync(DescribeWarehouseTablesOutput)(result.structuredContent)
		const notes = output.described?.[0]?.notes?.join("\n") ?? ""
		expect(notes).toContain("never sum across grains")
		expect(notes).toContain("max(IngestedAt)")
		expect(notes).toContain("sum(PositionSum) / sum(Impressions)")
	})

	it("runs the trend SQL the queries tool suggests, scoped to the org", async () => {
		const result = await call("run_sql", {
			sql: queryTrendSql(SITE, "acme o'reilly review"),
			start_time: "2026-10-01 00:00:00",
			end_time: "2026-10-28 23:59:59",
		})
		expect(result.isError).toBeUndefined()
		expect(
			Schema.decodeUnknownSync(RunSqlOutput)(result.structuredContent).managedOnlyTables,
		).toBeUndefined()
		expect(sqlSeen.at(-1)).toContain(`OrgId = '${FIXTURES.orgId}'`)
	})

	it("says an empty result may be a BYO ClickHouse that never receives the import", async () => {
		const result = await call("run_sql", {
			sql: "SELECT sum(Clicks) AS clicks FROM search_console_daily WHERE $__orgFilter AND Grain = 'site' AND $__timeFilter(Date)",
		})
		const output = Schema.decodeUnknownSync(RunSqlOutput)(result.structuredContent)
		expect(output.managedOnlyTables).toEqual(["search_console_daily"])
		expect(markdown(result)).toContain(
			"search_console_queries and search_console_pages read it on any setup",
		)
	})
})
