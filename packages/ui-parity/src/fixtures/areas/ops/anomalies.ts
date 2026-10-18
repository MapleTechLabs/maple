import { DateTime, Effect } from "effect"
import { AnomalyIncidentNotFoundError } from "@maple/domain/http"
import { encodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import { AnomalyIncidentId } from "@maple/domain/primitives"
import { CH, formatWarehouseDateTime } from "@maple/query-engine"
import type { FixtureWarehouse } from "../../../backend/warehouse.ts"
import { parityOrgId } from "../../../backend/warehouse.ts"
import type { Dataset, EndpointHandler } from "../../dataset.ts"
import { fixtureUuid, HOUR, MINUTE } from "../../identity.ts"
import { epochMs, iso, list, str } from "./synthetic.ts"

/**
 * Anomaly incidents are Postgres rows the detector tick writes; they are canned here in wire
 * form and agree with the seeded telemetry. The incident timeseries runs the detector's own
 * CH query (`anomalyTraceSignalTimeseriesQuery`) and shaping.
 */

const uuid = (index: number) => fixtureUuid(0x60, index)
export const ANOMALY_LATENCY_ID = uuid(1)
const publicId = (id: string) => encodePublicId(PublicIdPrefixes.anomalyIncident, id)

interface Seed {
	readonly id: string
	readonly signal: "latency_p95" | "error_rate" | "throughput"
	readonly service: string
	readonly severity: "warning" | "critical"
	readonly openedAgoMs: number
	readonly resolvedAgoMs: number | null
	readonly opened: number
	readonly median: number
	readonly sigma: number
	readonly threshold: number
	readonly last: number
	readonly samples: number
}

const SEEDS: ReadonlyArray<Seed> = [
	{
		id: uuid(1),
		signal: "latency_p95",
		service: "payment-svc",
		severity: "critical",
		openedAgoMs: 110 * MINUTE,
		resolvedAgoMs: null,
		opened: 1620,
		median: 412,
		sigma: 38,
		threshold: 640,
		last: 1840,
		samples: 3120,
	},
	{
		id: uuid(2),
		signal: "error_rate",
		service: "payment-svc",
		severity: "warning",
		openedAgoMs: 95 * MINUTE,
		resolvedAgoMs: null,
		opened: 0.061,
		median: 0.004,
		sigma: 0.002,
		threshold: 0.02,
		last: 0.074,
		samples: 3120,
	},
	{
		id: uuid(3),
		signal: "throughput",
		service: "catalog-api",
		severity: "warning",
		openedAgoMs: 19 * HOUR,
		resolvedAgoMs: 17 * HOUR,
		opened: 41,
		median: 96,
		sigma: 9,
		threshold: 60,
		last: 92,
		samples: 5400,
	},
]

const incident = (dataset: Dataset, seed: Seed) => {
	const nowMs = epochMs(dataset.now)
	return {
		id: publicId(seed.id),
		object: "anomaly_incident",
		detector_key: `${seed.signal}:${seed.service}:production`,
		signal_type: seed.signal,
		service_name: seed.service,
		deployment_env: "production",
		fingerprint_hash: null,
		error_issue_id: null,
		status: seed.resolvedAgoMs === null ? "open" : "resolved",
		severity: seed.severity,
		opened_value: seed.opened,
		baseline_median: seed.median,
		baseline_sigma: seed.sigma,
		threshold_value: seed.threshold,
		last_observed_value: seed.last,
		last_sample_count: seed.samples,
		first_triggered_at: iso(nowMs - seed.openedAgoMs),
		last_triggered_at: iso(nowMs - (seed.resolvedAgoMs ?? MINUTE)),
		resolved_at: seed.resolvedAgoMs === null ? null : iso(nowMs - seed.resolvedAgoMs),
		resolve_reason: seed.resolvedAgoMs === null ? null : "returned_to_baseline",
		triage_status: seed.resolvedAgoMs === null ? "completed" : "none",
		fingerprints: [],
		reopen_count: 0,
		last_reopened_at: null,
	}
}

const findSeed = (params: unknown) => {
	const id = str(params, "id")
	const seed = SEEDS.find((candidate) => candidate.id === id)
	return seed === undefined
		? Effect.fail(
				new AnomalyIncidentNotFoundError({
					message: "Anomaly incident not found",
					incidentId: AnomalyIncidentId.make(id ?? ""),
				}),
			)
		: Effect.succeed(seed)
}

const UNIT = { latency_p95: "milliseconds", error_rate: "ratio", throughput: "per_minute" } as const

export const anomalyDatasetEndpoints = (
	warehouse: FixtureWarehouse,
): Readonly<Record<string, EndpointHandler>> => ({
	"anomalies.listIncidents": ({ dataset, query }) => {
		const status = str(query, "status")
		const service = str(query, "service_name")
		const rows = SEEDS.map((seed) => incident(dataset, seed)).filter(
			(row) =>
				(status === undefined || row.status === status) &&
				(service === undefined || row.service_name === service),
		)
		return Effect.succeed(list(rows))
	},
	"anomalies.serviceCounts": ({ dataset }) =>
		Effect.succeed(
			list(
				SEEDS.filter((seed) => seed.resolvedAgoMs === null).map((seed) => ({
					object: "anomaly_service_count",
					service_name: seed.service,
					deployment_env: "production",
					signal_type: seed.signal,
					severity: seed.severity,
					incident_count: 1,
					last_triggered_at: iso(epochMs(dataset.now) - MINUTE),
				})),
			),
		),
	"anomalies.getIncident": ({ dataset, params }) =>
		Effect.map(findSeed(params), (seed) => incident(dataset, seed)),
	"anomalies.getIncidentTimeseries": ({ dataset, params }) =>
		Effect.gen(function* () {
			const seed = yield* findSeed(params)
			const nowMs = epochMs(dataset.now)
			const tenant = warehouse.tenantOf(parityOrgId(dataset.identity?.orgId ?? ""))
			const startMs = nowMs - seed.openedAgoMs - 24 * HOUR
			const endMs = Math.min(
				nowMs,
				seed.resolvedAgoMs === null ? nowMs : nowMs - seed.resolvedAgoMs + 2 * HOUR,
			)
			const rows = yield* warehouse.executor.compiledQuery(
				tenant,
				CH.compile(CH.anomalyTraceSignalTimeseriesQuery(), {
					orgId: tenant.orgId,
					startTime: formatWarehouseDateTime(startMs),
					endTime: formatWarehouseDateTime(endMs),
					serviceName: seed.service,
					deploymentEnv: "production",
				}),
				{ profile: "list", context: "anomalyTraceSignalTimeseries" },
			)
			const currentHourMs = Math.floor(nowMs / HOUR) * HOUR
			const trailing = Math.max(1, Math.floor((nowMs - currentHourMs) / MINUTE))
			return {
				object: "anomaly_incident.timeseries",
				signal_type: seed.signal,
				unit: UNIT[seed.signal],
				bucket_seconds: 3600,
				buckets: rows.map((row) => {
					const hourMs = DateTime.toEpochMillis(row.hour)
					const value =
						seed.signal === "error_rate"
							? row.requestCount > 0
								? row.errorCount / row.requestCount
								: 0
							: seed.signal === "latency_p95"
								? row.p95Ms
								: row.requestCount / (hourMs >= currentHourMs ? trailing : 60)
					return { bucket: iso(hourMs), value, sample_count: row.requestCount }
				}),
				baseline_median: seed.median,
				threshold_value: seed.threshold,
			}
		}),
	// The detail page's writes: nothing is persisted; each answers the incident as the server would.
	"anomalies.resolveIncident": ({ dataset, params }) =>
		Effect.map(findSeed(params), (seed) => ({
			...incident(dataset, seed),
			status: "resolved",
			resolved_at: iso(epochMs(dataset.now)),
			resolve_reason: "manual",
		})),
	"anomalies.setIncidentIssue": ({ dataset, params, payload }) =>
		Effect.map(findSeed(params), (seed) => {
			const issueId = str(payload, "issue_id")
			return {
				...incident(dataset, seed),
				error_issue_id: issueId === undefined ? null : encodePublicId(PublicIdPrefixes.errorIssue, issueId),
			}
		}),
	"anomalies.getSettings": () =>
		Effect.succeed({
			object: "anomaly_settings",
			enabled: true,
			sensitivity: "normal",
			muted_signals: [],
			updated_at: null,
			updated_by: null,
		}),
})
