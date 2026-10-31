import { describe, expect, it } from "vitest"
import { healthSummary, serviceHealthRowKey } from "./derive"
import type { IncidentCause, ServiceRow } from "./model"

const service = (serviceName: string): ServiceRow => ({
	serviceName,
	serviceNamespace: "",
	environment: "production",
	commits: [],
	p50LatencyMs: 10,
	p95LatencyMs: 20,
	p99LatencyMs: 30,
	errorRate: 0,
	throughput: 1,
	tracedThroughput: 1,
	hasSampling: false,
	samplingWeight: 1,
	spanCount: 10,
})

const incident = (groupKey: string, signalType: IncidentCause["signalType"]): IncidentCause => ({
	status: "open",
	groupKey,
	severity: "critical",
	signalType,
})

describe("healthSummary", () => {
	it("marks a service unhealthy while its uptime check or an alert rule is firing", () => {
		const summary = healthSummary(
			[service("checkout-api"), service("payments"), service("search")],
			[incident("checkout-api", "uptime"), incident("payments", "error_rate")],
			[],
			Date.parse("2026-10-26T00:00:00Z"),
		)
		const health = (name: string) => summary.byRow.get(serviceHealthRowKey(name, "production"))
		expect([health("checkout-api"), health("payments"), health("search")]).toEqual([
			"unhealthy",
			"unhealthy",
			"healthy",
		])
		expect(summary.counts).toEqual({ healthy: 1, degraded: 0, unhealthy: 2 })
	})
})
