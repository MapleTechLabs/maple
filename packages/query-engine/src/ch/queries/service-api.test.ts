import { describe, expect, it } from "vitest"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import { serviceApiTimeseriesQuery, serviceApiTotalsQuery } from "./service-api"

const params = {
	orgId: OrgId.make("org_1"),
	startTime: "2024-01-01 00:10:00",
	endTime: "2024-01-02 00:20:00",
}

const orgScopes = (sql: string) => sql.split("OrgId = 'org_1'").length - 1

describe("serviceApiTotalsQuery", () => {
	it("splices raw edges, minutely edges and the hourly interior", () => {
		const { sql } = compileUnsafe(serviceApiTotalsQuery({ serviceName: "api" }), params)
		expect(sql).toContain("FROM service_operations_hourly")
		expect(sql).toContain("FROM service_operations_minutely")
		expect(sql).toContain("FROM traces")
		expect(orgScopes(sql)).toBe(3)
	})

	it("reads only raw traces on the fallback tier", () => {
		const { sql } = compileUnsafe(serviceApiTotalsQuery({ serviceName: "api", tiers: "raw" }), params)
		expect(sql).not.toContain("service_operations_")
		expect(sql).toContain("FROM traces")
	})
})

describe("serviceApiTimeseriesQuery", () => {
	const compileTs = (bucketSeconds: number, spanNames?: readonly string[]) =>
		compileUnsafe(serviceApiTimeseriesQuery({ serviceName: "api", bucketSeconds, spanNames }), {
			...params,
			bucketSeconds,
		}).sql

	it("reads the hourly tier only when a bucket spans at least an hour", () => {
		expect(compileTs(300)).not.toContain("FROM service_operations_hourly")
		expect(compileTs(300)).toContain("FROM service_operations_minutely")
		expect(compileTs(3600)).toContain("FROM service_operations_hourly")
	})

	it("filters the merged series to HTTP endpoints", () => {
		const sql = compileTs(300)
		expect(sql).toContain(
			"match(service_operations_minutely.SpanName, '^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) ')",
		)
	})

	it("keeps one series per named endpoint", () => {
		const sql = compileTs(3600, ["GET /a", "POST /b"])
		expect(sql).toContain("service_operations_hourly.SpanName IN ('GET /a', 'POST /b')")
		expect(sql).not.toContain("'' AS bSpanName")
	})
})
