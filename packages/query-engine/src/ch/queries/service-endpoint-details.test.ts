import { describe, expect, it } from "vitest"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import {
	serviceEndpointDistributionQuery,
	serviceEndpointSlowestQuery,
	serviceEndpointStatusBreakdownQuery,
} from "./service-endpoint-details"

const params = {
	orgId: OrgId.make("org_1"),
	startTime: "2024-01-01 00:10:00",
	endTime: "2024-01-02 00:20:00",
}

describe("service endpoint details", () => {
	it("reads only the hourly rollup, both window ends floored to the hour", () => {
		const { sql } = compileUnsafe(serviceEndpointStatusBreakdownQuery({ serviceName: "api" }), params)
		expect(sql).toContain("FROM service_endpoint_details_hourly")
		expect(sql).not.toContain("FROM traces")
		expect(sql).toContain("Hour >= toStartOfHour(toDateTime('2024-01-01 00:10:00'))")
		expect(sql).toContain("Hour <= toStartOfHour(toDateTime('2024-01-02 00:20:00'))")
		expect(sql).toContain("OrgId = 'org_1'")
	})

	it("narrows the breakdown to HTTP endpoints, or to the one asked for", () => {
		const all = compileUnsafe(serviceEndpointStatusBreakdownQuery({ serviceName: "api" }), params).sql
		const one = compileUnsafe(
			serviceEndpointStatusBreakdownQuery({ serviceName: "api", spanName: "GET /a" }),
			params,
		).sql
		expect(all).toContain("match(service_endpoint_details_hourly.SpanName")
		expect(one).toContain("SpanName = 'GET /a'")
		expect(one).not.toContain("match(")
	})

	it("drops the empty user agent from the top list", () => {
		const { sql } = compileUnsafe(
			serviceEndpointDistributionQuery({ serviceName: "api", spanName: "GET /a" }),
			params,
		)
		expect(sql).toContain("arrayFilter(x -> x.1 != '', approx_top_kMerge(10)(UserAgents))")
	})

	it("ranks the slowest requests by duration across hour and status rows", () => {
		const { sql } = compileUnsafe(
			serviceEndpointSlowestQuery({ serviceName: "api", spanName: "GET /a", limit: 3 }),
			params,
		)
		expect(sql).toContain("GROUP BY hour, httpStatusCode")
		expect(sql).toContain("ORDER BY durationMs DESC")
		expect(sql).toContain("LIMIT 3")
	})
})
