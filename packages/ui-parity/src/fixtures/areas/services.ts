import { Effect } from "effect"
import { ServiceOverviewResponse } from "@maple/domain/http"
import type { FixtureArea } from "../areas.ts"
import type { Dataset } from "../dataset.ts"
import { FROZEN_NOW, FROZEN_NOW_MS, HOUR, newOrgAdmin } from "../identity.ts"
import { emptyTelemetry } from "../telemetry/rows.ts"

/**
 * `services-edge`: the services list's rarer rows, which Acme Shop never produces. A service whose
 * SDK never set `service.name` (`UnnamedServiceHint`) and a head-sampled one (the estimated
 * throughput and its tooltip). The overview is canned; every other read is empty.
 */

const deployedAt = (hoursAgo: number) =>
	new Date(FROZEN_NOW_MS - hoursAgo * HOUR).toISOString().replace("T", " ").slice(0, 19)

const SHA = "4f1c2a9be07d3c5a8e61f2b9d0c47a3e5b8f1d26"

const row = (fields: {
	readonly serviceName: string
	readonly spanCount: number
	readonly estimatedSpanCount: number
	readonly p95LatencyMs: number
}) => ({
	serviceName: fields.serviceName,
	serviceNamespace: "",
	environment: "production",
	commits: [[SHA, fields.spanCount, 0, deployedAt(5)]],
	p50LatencyMs: fields.p95LatencyMs / 3,
	p95LatencyMs: fields.p95LatencyMs,
	p99LatencyMs: fields.p95LatencyMs * 2,
	spanCount: fields.spanCount,
	errorCount: 0,
	estimatedSpanCount: fields.estimatedSpanCount,
	estimatedErrorCount: 0,
})

const servicesEdgeDataset: Dataset = {
	name: "services-edge",
	now: FROZEN_NOW,
	identity: newOrgAdmin,
	auth: "self_hosted",
	endpoints: {
		"queryEngine.serviceOverview": () =>
			Effect.succeed(
				new ServiceOverviewResponse({
					data: [
						row({ serviceName: "unknown_service:node", spanCount: 1_200, estimatedSpanCount: 1_200, p95LatencyMs: 84 }),
						row({ serviceName: "ingest-worker", spanCount: 900, estimatedSpanCount: 9_000, p95LatencyMs: 212 }),
					],
				}),
			),
	},
	synced: {},
	telemetry: emptyTelemetry,
}

export const fixtureArea: FixtureArea = {
	area: "services",
	datasets: [servicesEdgeDataset],
}
