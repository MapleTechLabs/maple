import { describe, expect, it } from "vitest"
import { DateTime, Effect } from "effect"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import {
	supabaseApiTopPathsSQL,
	supabaseApiTrafficSeriesSQL,
	supabaseApiTrafficTotalsSQL,
	supabaseLogIssuesSQL,
	supabaseLogsProjectsSummarySQL,
	supabaseProjectCallerSeriesSQL,
	supabaseProjectCallersSQL,
} from "./supabase-insights"

// The SQL text is pinned by the integrations baseline (`__sql_baseline__/integrations.sql`).

const window = {
	orgId: OrgId.make("org_1"),
	startTime: "2026-10-21 00:00:00",
	endTime: "2026-10-21 06:00:00",
}
const project = { ...window, projectRef: "abcdefghijklmnopqrst" }
const bucketed = { ...project, bucketSeconds: 300 }

describe("supabase insights queries", () => {
	it("scope every read to one org", () => {
		const scopes = [
			compileUnsafe(supabaseApiTrafficSeriesSQL(), bucketed),
			compileUnsafe(supabaseApiTrafficTotalsSQL(), project),
			compileUnsafe(supabaseApiTopPathsSQL(), project),
			compileUnsafe(supabaseLogIssuesSQL({ byProject: true }), project),
			compileUnsafe(supabaseLogIssuesSQL({ byProject: false }), window),
			compileUnsafe(supabaseLogsProjectsSummarySQL(), window),
			compileUnsafe(supabaseProjectCallersSQL(), project),
			compileUnsafe(supabaseProjectCallerSeriesSQL(), bucketed),
		].map((compiled) => compiled.tenantScope)
		expect(new Set(scopes)).toEqual(new Set(["single-tenant"]))
	})

	it("decodes quoted ClickHouse counts in the traffic series and totals", () => {
		const series = Effect.runSync(
			compileUnsafe(supabaseApiTrafficSeriesSQL(), bucketed).decodeRows([
				{
					bucket: "2026-10-21T00:05:00.000000Z",
					status2xx: "120",
					status3xx: "0",
					status4xx: "7",
					status5xx: "2",
				},
			]),
		)
		expect(series[0]).toEqual({
			bucket: "2026-10-21T00:05:00.000000Z",
			status2xx: 120,
			status3xx: 0,
			status4xx: 7,
			status5xx: 2,
		})
		const totals = Effect.runSync(
			compileUnsafe(supabaseApiTrafficTotalsSQL(), project).decodeRows([
				{ requests: "129", errors5xx: "2", p95OriginMs: 41.5 },
			]),
		)
		expect(totals[0]).toEqual({ requests: 129, errors5xx: 2, p95OriginMs: 41.5 })
	})

	it("decodes a log issue's last-seen time as UTC", () => {
		const rows = Effect.runSync(
			compileUnsafe(supabaseLogIssuesSQL({ byProject: false }), window).decodeRows([
				{
					projectRef: "abcdefghijklmnopqrst",
					source: "postgres_logs",
					message: 'relation "orders_0" does not exist',
					count: "14",
					lastSeen: "2026-10-21 05:59:58.123456789",
					maxSeverity: 17,
				},
			]),
		)
		expect(rows[0]?.count).toBe(14)
		expect(DateTime.formatIso(rows[0]!.lastSeen)).toBe("2026-10-21T05:59:58.123Z")
	})

	it("decodes the callers' product mix and rates", () => {
		const rows = Effect.runSync(
			compileUnsafe(supabaseProjectCallersSQL(), project).decodeRows([
				{
					serviceName: "checkout-api",
					calls: "360",
					callsPerMinute: 1,
					errors: "3",
					errorRate: 0.0083,
					p95DurationMs: 85.2,
					rest: "300",
					auth: "40",
					storage: "0",
					realtime: "0",
					functions: "0",
					postgres: "20",
					other: "0",
				},
			]),
		)
		expect(rows[0]).toMatchObject({ serviceName: "checkout-api", calls: 360, rest: 300, postgres: 20 })
	})

	it("decodes the projects summary", () => {
		const rows = Effect.runSync(
			compileUnsafe(supabaseLogsProjectsSummarySQL(), window).decodeRows([
				{
					projectRef: "abcdefghijklmnopqrst",
					requests: "720",
					requestsPerMinute: 2,
					errors5xx: "4",
					issueCount: "31",
					lastSeen: "2026-10-21 05:59:00.000000000",
				},
			]),
		)
		expect(rows[0]).toMatchObject({ requests: 720, requestsPerMinute: 2, errors5xx: 4, issueCount: 31 })
	})
})
