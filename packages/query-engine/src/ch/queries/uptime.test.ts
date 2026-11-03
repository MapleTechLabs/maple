import { describe, expect, it } from "@effect/vitest"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import { uptimeChecksQuery, uptimePhaseTimingsQuery } from "./uptime"

const compiled = () =>
	compileUnsafe(uptimePhaseTimingsQuery(), {
		orgId: OrgId.make("org_1"),
		monitorId: "mon_1",
		startTime: "2026-10-26 00:00:00",
		endTime: "2026-10-27 00:00:00",
		bucketSeconds: 3600,
	}).sql

describe("uptimePhaseTimingsQuery", () => {
	it("reads only the org's root check spans of the one monitor, in the window", () => {
		const sql = compiled()
		expect(sql).toContain("traces.OrgId = 'org_1'")
		expect(sql).toContain("traces.ServiceName = 'maple-uptime'")
		expect(sql).toContain("traces.ParentSpanId = ''")
		expect(sql).toContain("traces.ResourceAttributes['maple.uptime.monitor_id'] = 'mon_1'")
		expect(sql).toContain("traces.Timestamp >= '2026-10-26 00:00:00'")
	})

	it("averages every phase over the same checks, those that got a response", () => {
		const answered = "traces.SpanAttributes['maple.uptime.timing.ttfb_ms'] != ''"
		const sql = compiled()
		for (const phase of ["dns", "connect", "tls", "ttfb", "transfer"]) {
			expect(sql).toContain(
				`avgIf(toFloat64OrZero(traces.SpanAttributes['maple.uptime.timing.${phase}_ms']), ${answered})`,
			)
		}
		expect(sql).toContain(`countIf(${answered}) AS timedChecks`)
	})
})

describe("uptimeChecksQuery", () => {
	it("lists only the org's root check spans of the one monitor, newest first and capped", () => {
		const { sql } = compileUnsafe(uptimeChecksQuery({ limit: 3000 }), {
			orgId: OrgId.make("org_1"),
			monitorId: "mon_1",
			startTime: "2026-10-26 00:00:00",
			endTime: "2026-10-27 00:00:00",
		})
		expect(sql).toContain("traces.OrgId = 'org_1'")
		expect(sql).toContain("traces.ParentSpanId = ''")
		expect(sql).toContain("traces.ResourceAttributes['maple.uptime.monitor_id'] = 'mon_1'")
		expect(sql).toContain("ORDER BY at DESC")
		expect(sql).toContain("LIMIT 3000")
	})
})
