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
	it("names an open uptime incident as a failing check and keeps the alert label for rules", () => {
		const summary = healthSummary(
			[service("checkout-api"), service("payments")],
			[incident("checkout-api", "uptime"), incident("payments", "error_rate")],
			[],
			Date.parse("2026-10-26T00:00:00Z"),
		)
		const causes = (name: string) =>
			summary.causesByRow.get(serviceHealthRowKey(name, "production"))?.map((cause) => cause.label)
		expect(causes("checkout-api")).toEqual(["Uptime check failing"])
		expect(causes("payments")).toEqual(["Alert firing"])
		expect(summary.counts.unhealthy).toBe(2)
	})
})
