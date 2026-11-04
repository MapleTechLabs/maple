import { describe, expect, it } from "vitest"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import {
	userActivityServicesQuery,
	userActivitySlicesQuery,
	userActivitySummaryQuery,
	userActivityTotalsQuery,
	userLogsQuery,
	userTracesQuery,
} from "./user-activity"

const params = {
	orgId: OrgId.make("org_1"),
	startTime: "2024-01-01 00:10:00",
	endTime: "2024-01-02 00:20:00",
}

const scope = { userId: "u_42", namespaces: ["storefront", "billing"] }

describe("user activity rollup reads", () => {
	it("reads only the hourly rollup, scoped to the org, user, namespaces and floored window", () => {
		const { sql } = compileUnsafe(userActivitySlicesQuery(scope), params)
		expect(sql).toContain("FROM user_activity_hourly")
		expect(sql).not.toContain("FROM traces")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("UserId = 'u_42'")
		expect(sql).toMatch(/ServiceNamespace IN \('storefront', 'billing'\)/)
		expect(sql).toContain("Hour >= toStartOfHour(toDateTime('2024-01-01 00:10:00'))")
		expect(sql).toContain("Hour <= toStartOfHour(toDateTime('2024-01-02 00:20:00'))")
		expect(sql).toContain("GROUP BY hour, serviceName, serviceNamespace")
	})

	it("leaves every namespace in when the scope is empty", () => {
		const { sql } = compileUnsafe(userActivitySlicesQuery({ userId: "u_42", namespaces: [] }), params)
		expect(sql).not.toContain("ServiceNamespace IN")
	})

	it("merges the summary's states and guards the empty latency digest", () => {
		const { sql } = compileUnsafe(userActivitySummaryQuery(scope), params)
		expect(sql).toContain("uniqIfMerge(TraceIds)")
		expect(sql).toContain("uniqIfMerge(SessionIds)")
		expect(sql).toContain("if(sum(RequestCount) > 0, arrayElement(quantilesTDigestIfMerge(0.5, 0.95)")
		expect(sql).toContain("arrayFilter(x -> x.1 != '', approx_top_kMerge(10)(TopRoutes))")
		expect(sql).not.toContain("GROUP BY")
	})

	it("breaks a user's activity down by service and namespace", () => {
		const { sql } = compileUnsafe(userActivityServicesQuery(scope), params)
		expect(sql).toContain("GROUP BY serviceName, serviceNamespace")
		expect(sql).toContain("UserId = 'u_42'")
	})

	it("totals a page of users in one read, and none for an empty page", () => {
		const page = compileUnsafe(userActivityTotalsQuery({ userIds: ["a", "b"] }), params).sql
		expect(page).toMatch(/UserId IN \('a', 'b'\)/)
		expect(page).toContain("GROUP BY userId")
		expect(page).toContain("OrgId = 'org_1'")
		const empty = compileUnsafe(userActivityTotalsQuery({ userIds: [] }), params).sql
		expect(empty).toContain("1 = 0")
	})

	it("gives each listed user their top route and requests per hour", () => {
		const { sql } = compileUnsafe(userActivityTotalsQuery({ userIds: ["a"] }), params)
		expect(sql).toContain("arrayFilter(x -> x.1 != '', approx_top_kMerge(10)(TopRoutes))")
		expect(sql).toContain("sumMap([toUInt32(toUnixTimestamp(Hour))], [toUInt64(RequestCount)])")
	})
})

describe("user raw reads", () => {
	const raw = { ...scope, serviceNames: ["checkout", "cart"] }

	it("prunes traces by the slices' services and window before the user predicate", () => {
		const { sql } = compileUnsafe(userTracesQuery(raw), params)
		expect(sql).toContain("FROM traces")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toMatch(/ServiceName IN \('checkout', 'cart'\)/)
		expect(sql).toMatch(/Timestamp >= /)
		expect(sql).toMatch(/Timestamp <= /)
		expect(sql).toContain("SpanAttributes['user.id'] = 'u_42'")
		expect(sql).toContain("SpanAttributes['enduser.id'] = 'u_42'")
		expect(sql).toMatch(/ResourceAttributes\['service.namespace'\] IN \('storefront', 'billing'\)/)
		expect(sql).toContain("IsEntryPoint = 1")
		expect(sql).toContain("ORDER BY timestamp DESC")
	})

	it("reads nothing when the slices name no service", () => {
		const { sql } = compileUnsafe(userTracesQuery({ ...raw, serviceNames: [] }), params)
		expect(sql).toContain("1 = 0")
	})

	it("narrows to failed requests on request", () => {
		const all = compileUnsafe(userTracesQuery(raw), params).sql
		const failed = compileUnsafe(userTracesQuery({ ...raw, errorsOnly: true }), params).sql
		expect(all).not.toContain("StatusCode = 'Error'")
		expect(failed).toContain("StatusCode = 'Error'")
	})

	it("keeps failed or slow requests for the timeline", () => {
		const { sql } = compileUnsafe(userTracesQuery({ ...raw, notableSlowerThanMs: 2000 }), params)
		expect(sql).toContain("(traces.StatusCode = 'Error' OR traces.Duration >= 2000000000)")
	})

	it("prunes logs by partition time, sort-key time and service", () => {
		const { sql } = compileUnsafe(userLogsQuery({ ...raw, minSeverity: 13 }), params)
		expect(sql).toContain("FROM logs")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toMatch(/TimestampTime >= /)
		expect(sql).toMatch(/ServiceName IN \('checkout', 'cart'\)/)
		expect(sql).toContain("LogAttributes['user.id'] = 'u_42'")
		expect(sql).toContain("LogAttributes['enduser.id'] = 'u_42'")
		expect(sql).toMatch(/ResourceAttributes\['service.namespace'\] IN \('storefront', 'billing'\)/)
		expect(sql).toContain("SeverityNumber >= 13")
	})
})
