import { describe, expect, it } from "vitest"
import { healthSummary, perSecondRates, serviceHealthRowKey } from "./derive"
import type { ServiceRow } from "./model"
import type { HealthIncident } from "../../kit/service-health"

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

const incident = (groupKey: string, signalType: HealthIncident["signalType"]): HealthIncident => ({
	ruleId: `rule-${groupKey}`,
	ruleName: `${groupKey} errors`,
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

describe("perSecondRates", () => {
	const window = {
		startMs: Date.parse("2026-10-01T00:00:00Z"),
		endMs: Date.parse("2026-10-01T00:02:30Z"),
		bucketSeconds: 60,
	}

	it("divides each full bucket's count by the bucket length", () => {
		const rates = perSecondRates(
			[
				{ bucket: "2026-10-01 00:00:00", throughput: 120 },
				{ bucket: "2026-10-01 00:01:00", throughput: 30 },
			],
			window,
		)
		expect(rates).toEqual([2, 0.5])
	})

	it("reads the bucket the window ends inside over the seconds it covers", () => {
		// 00:02:00 to 00:02:30 is 30 seconds of a 60-second bucket.
		const [rate] = perSecondRates([{ bucket: "2026-10-01 00:02:00", throughput: 30 }], window)
		expect(rate).toBe(1)
	})

	it("a window ending exactly on a bucket edge leaves the last bucket whole", () => {
		const [rate] = perSecondRates([{ bucket: "2026-10-01 00:01:00", throughput: 60 }], {
			...window,
			endMs: Date.parse("2026-10-01T00:02:00Z"),
		})
		expect(rate).toBe(1)
	})

	it("a bucket outside the window reads zero rather than dividing by nothing", () => {
		const [rate] = perSecondRates([{ bucket: "2026-10-01 00:05:00", throughput: 10 }], window)
		expect(rate).toBe(0)
	})
})
