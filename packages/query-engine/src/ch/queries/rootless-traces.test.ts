import { describe, expect, it } from "vitest"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import {
	ROOTLESS_ENTRY_BUDGET,
	ROOTLESS_PAGE_ROOT_BUDGET,
	ROOTLESS_ROOT_BUDGET,
	rootedTraceIdsQuery,
	rootlessOmittedQuery,
	rootSpansInRangeQuery,
} from "./rootless-traces"

const params = {
	orgId: OrgId.make("org_1"),
	startTime: "2024-01-01 12:00:00",
	endTime: "2024-01-01 12:05:00",
}

describe("rootedTraceIdsQuery", () => {
	const { sql } = compileUnsafe(rootedTraceIdsQuery(["t1", "t2"]), params)

	it("looks the candidates up among root spans from an hour before their range", () => {
		expect(sql).toContain("FROM trace_list_mv")
		expect(sql).toContain("trace_list_mv.OrgId = 'org_1'")
		expect(sql).toContain(
			"trace_list_mv.Timestamp >= subtractHours(toDateTime('2024-01-01 12:00:00'), 1)",
		)
		expect(sql).toContain("trace_list_mv.Timestamp <= '2024-01-01 12:05:00'")
		expect(sql).toContain("trace_list_mv.TraceId IN ('t1', 't2')")
	})

	it("reads nothing once that range holds more roots than a page may read", () => {
		expect(sql).toContain(`LIMIT ${ROOTLESS_PAGE_ROOT_BUDGET + 1})) <= ${ROOTLESS_PAGE_ROOT_BUDGET}`)
		// The count the caller reads to learn that it did.
		const count = compileUnsafe(rootSpansInRangeQuery(), params).sql
		expect(count).toContain("count() AS roots")
		expect(count).toContain(`LIMIT ${ROOTLESS_PAGE_ROOT_BUDGET + 1}`)
		expect(count).toContain("subtractHours(toDateTime('2024-01-01 12:00:00'), 1)")
	})
})

describe("rootlessOmittedQuery", () => {
	it("returns a row when the window has settled entry spans and either budget is spent", () => {
		const { sql } = compileUnsafe(rootlessOmittedQuery(), params)

		expect(sql).toContain("FROM trace_list_entry_spans")
		expect(sql).toContain("trace_list_entry_spans.OrgId = 'org_1'")
		expect(sql).toContain("trace_list_entry_spans.Timestamp <= now() - INTERVAL 30 SECOND")
		expect(sql).toMatch(/AND NOT \(\(\(SELECT count\(\) FROM \(SELECT/)
		expect(sql).toContain(`LIMIT ${ROOTLESS_ROOT_BUDGET + 1})) <= ${ROOTLESS_ROOT_BUDGET}`)
		expect(sql).toContain(`LIMIT ${ROOTLESS_ENTRY_BUDGET + 1})) <= ${ROOTLESS_ENTRY_BUDGET}`)
		expect(sql).toMatch(/LIMIT 1\s+FORMAT JSON$/)
	})
})
