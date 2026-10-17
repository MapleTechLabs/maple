import { Schema } from "effect"
import {
	ErrorsByTypeResponse,
	ListHostsResponse,
	ListLogsResponse,
	ListMetricsResponse,
	RawSqlExecuteResponse,
	ServiceHealthSnapshotResponse,
	ServiceMapBundleResponse,
	ServiceOperationsResponse,
	ServiceOverviewResponse,
	ServiceUsageResponse,
	SpanDetailResponse,
	SpanHierarchyResponse,
} from "@maple/domain/http"
import { V2ErrorIssueDetail, V2TelemetrySignals } from "@maple/domain/http/v2"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { spawnBackend } from "./testing.ts"

const window = { startTime: "2026-09-30 12:00:00", endTime: "2026-10-01 12:00:00" }
const ERROR_TRACE_ID = "6843a8853182b32339b2dd5120d423f2"

const backends: Array<Awaited<ReturnType<typeof spawnBackend>>> = []
beforeAll(async () => {
	backends.push(await spawnBackend())
}, 60_000)
afterAll(() => Promise.all(backends.map((backend) => backend.stop())))

/** Asks twice: both answers must be 200, byte-identical, and decode with the endpoint's schema. */
const answer = async <A, I>(schema: Schema.Codec<A, I>, path: string, body?: unknown) => {
	const request = backends[0]?.request ?? (() => Promise.reject(new Error("backend not started")))
	const first = await request("default", path, body)
	const second = await request("default", path, body)
	expect(first.status).toBe(200)
	expect(second.text).toBe(first.text)
	return Schema.decodeUnknownSync(Schema.fromJsonString(schema))(first.text)
}

const qe = (endpoint: string) => `/internal/query-engine/${endpoint}`

describe("service endpoints", () => {
	it("answers the services list, health and usage with every Acme service", async () => {
		const overview = await answer(ServiceOverviewResponse, qe("service-overview"), window)
		expect(overview.data.map((row) => row.serviceName)).toEqual(expect.arrayContaining(["payment-svc", "storefront"]))
		const health = await answer(ServiceHealthSnapshotResponse, qe("service-health-snapshot"), window)
		expect(health.data.length).toBe(6)
		const usage = await answer(ServiceUsageResponse, qe("service-usage"), window)
		// Hostmetrics rows carry no service.name, so usage has a seventh, unnamed row.
		expect(usage.data.map((row) => row.serviceName)).toEqual(expect.arrayContaining(["payment-svc", "auth-svc", ""]))
	})

	it("answers the service map with sealed service-to-service edges", async () => {
		const map = await answer(ServiceMapBundleResponse, qe("service-map-bundle"), window)
		expect(map.dependencies).toContainEqual(expect.objectContaining({ sourceService: "storefront", targetService: "payment-svc" }))
	})

	it("answers payment-svc operations with per-operation sparklines", async () => {
		const operations = await answer(ServiceOperationsResponse, qe("service-operations"), { ...window, serviceName: "payment-svc" })
		expect(operations.data.length).toBeGreaterThan(0)
		expect(operations.data[0]?.sparkline.length).toBeGreaterThan(0)
	})
})

describe("trace endpoints", () => {
	it("resolves the error trace's spans without a window and its root span's attributes", async () => {
		const hierarchy = await answer(SpanHierarchyResponse, qe("span-hierarchy"), { traceId: ERROR_TRACE_ID })
		expect(hierarchy.data.some((span) => span.statusCode === "Error")).toBe(true)
		const root = hierarchy.data[0]
		const detail = await answer(SpanDetailResponse, qe("span-detail"), { traceId: ERROR_TRACE_ID, spanId: root?.spanId })
		expect(detail.data?.resourceAttributes).toContain(`"service.name":"${root?.serviceName}"`)
	})
})

describe("signal endpoints", () => {
	it("answers errors, logs, metrics and raw SQL from the seeded telemetry", async () => {
		const errors = await answer(ErrorsByTypeResponse, qe("errors-by-type"), window)
		expect(errors.data.map((row) => row.errorLabel)).toContain("ConnectionTimeout")
		const logs = await answer(ListLogsResponse, qe("list-logs"), { ...window, limit: 5 })
		expect(logs.data.length).toBe(5)
		const metrics = await answer(ListMetricsResponse, qe("list-metrics"), { ...window, limit: 50 })
		expect(metrics.data.map((row) => row.metricName)).toContain("db.client.connection.count")
		const sql = "SELECT ServiceName, count() AS spans FROM traces WHERE $__orgFilter AND $__timeFilter(Timestamp) GROUP BY ServiceName ORDER BY ServiceName"
		const raw = await answer(RawSqlExecuteResponse, qe("execute-raw-sql"), { ...window, sql, displayType: "table" })
		expect(raw.meta.rowCount).toBe(6)
	})
})

describe("infra, issue and presence endpoints", () => {
	it("lists the four hostmetrics nodes", async () => {
		const hosts = await answer(ListHostsResponse, qe("list-hosts"), window)
		expect(hosts.data.length).toBe(4)
	})

	it("seeds an issue per warehouse fingerprint and serves its detail charts", async () => {
		const list = await answer(Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) }), "/v2/error_issues")
		const first = list.data[0]?.id ?? ""
		const detail = await answer(V2ErrorIssueDetail, `/v2/error_issues/${first}`)
		expect(detail.timeseries.length).toBeGreaterThan(0)
		expect(detail.sample_traces.length).toBeGreaterThan(0)
	})

	it("reports traces, logs and metrics present at the frozen clock", async () => {
		const signals = await answer(V2TelemetrySignals, "/v2/instrumentation/signals")
		expect(signals.generated_at).toBe("2026-10-01T12:00:00.000Z")
		expect(signals.signals.filter((signal) => signal.status === "present").map((signal) => signal.signal)).toEqual(["traces", "logs", "metrics"])
	})
})
