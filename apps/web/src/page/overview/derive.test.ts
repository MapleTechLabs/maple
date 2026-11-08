import type { V2AnomalyServiceCount } from "@maple/domain/http/v2"
import { Array as Arr } from "effect"
import { describe, expect, test } from "vitest"
import { type EnrichedService, enrichServices } from "./derive"
import type { HealthSnapshot, Incident } from "./model"

const NOW = Date.parse("2026-10-01T12:00:00.000Z")
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()

const service = (serviceName: string, environment = "production"): HealthSnapshot => ({
	serviceName,
	environment,
	errorRate: 0,
	p95LatencyMs: 0,
	throughput: 0,
})

const anomaly = (fields: Partial<V2AnomalyServiceCount>): V2AnomalyServiceCount => ({
	object: "anomaly_service_count",
	service_name: "checkout",
	deployment_env: "production",
	signal_type: "latency_p95",
	severity: "warning",
	incident_count: 1,
	last_triggered_at: minutesAgo(5),
	...fields,
})

const incident = (fields: Partial<Incident>): Incident => ({
	status: "open",
	groupKey: "checkout",
	severity: "critical",
	signalType: "error_rate",
	...fields,
})

const causeLabels = (
	rows: ReadonlyArray<EnrichedService>,
	name: string,
	environment = "production",
): ReadonlyArray<string> =>
	Arr.flatMap(rows, (row: EnrichedService) =>
		row.service.serviceName === name && row.service.environment === environment
			? Arr.map(row.causes, (cause) => cause.label)
			: [],
	)

describe("enrichServices", () => {
	// Alert incidents match on the service name alone; anomalies also on the environment.
	test("each service gets its open incidents and its fresh anomalies, critical first", () => {
		const rows = enrichServices(
			[service("checkout"), service("checkout", "staging"), service("search"), service("")],
			[
				incident({ severity: "warning" }),
				incident({ status: "resolved", groupKey: "search" }),
				incident({ groupKey: null }),
			],
			[
				anomaly({ severity: "critical", signal_type: "error_rate" }),
				anomaly({ deployment_env: "staging" }),
				anomaly({ service_name: "search", last_triggered_at: minutesAgo(90) }),
				anomaly({ service_name: "search", signal_type: "error_spike" }),
			],
			NOW,
		)
		expect(causeLabels(rows, "checkout")).toEqual(["Error rate anomaly", "Alert firing"])
		expect(causeLabels(rows, "checkout", "staging")).toEqual(["Alert firing", "Latency anomaly"])
		expect(causeLabels(rows, "search")).toEqual([])
		expect(causeLabels(rows, "")).toEqual([])
	})
})
