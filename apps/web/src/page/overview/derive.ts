import type { V2AnomalyServiceCount } from "@maple/domain/http/v2"
import type { AnomalySignalType } from "@maple/domain/http"
import {
	anomalyDirection,
	deriveServiceHealthFromCauses,
	healthRank,
	type ServiceHealth,
	type ServiceHealthCause,
} from "../../components/dashboard/service-health"
import { DateTime, Option } from "effect"
import { AsyncData } from "foldkit"
import type { FacetsHint, HealthSnapshot, Incident, Model } from "./model"

// Pure derivations of the home page (`defaultPreset`, `environmentFilter`) and its service health
// section (`enrichServices`, `countByHealth`).

export type { ServiceHealth, ServiceHealthCause }

/** `defaultPreset`: the hint's preset until facets resolve; 6h for all-demo orgs, else 24h. */
export const defaultPreset = (model: Model): string =>
	Option.match(AsyncData.getData(model.facets.data), {
		onNone: () => model.hint.preset,
		onSome: ({ services }) =>
			services.length === 0 ? "24h" : services.every((name) => name.startsWith("demo-")) ? "6h" : "24h",
	})

export const timePresetOf = (model: Model): string => model.search.timePreset ?? defaultPreset(model)

/** `facetsReady`: facets settled, success or failure (`!Result.isInitial`). */
export const facetsReady = (model: Model): boolean =>
	AsyncData.isSuccess(model.facets.data) || AsyncData.isFailure(model.facets.data)

const environmentsOf = (model: Model): ReadonlyArray<string> =>
	Option.getOrElse(
		Option.map(AsyncData.getData(model.facets.data), (facets) => facets.environments),
		() => [],
	)

const hasProduction = (model: Model) => environmentsOf(model).includes("production")

/** `derivedDefaultEnvironment`: "production" when facets list it, else all (`null`). */
export const derivedDefaultEnvironment = (model: Model): string | null =>
	facetsReady(model) && hasProduction(model) ? "production" : null

/** `environmentFilter`: the URL wins; then the facets default; before facets, the stored hint. */
export const environmentFilter = (model: Model): ReadonlyArray<string> | undefined => {
	if (model.search.environment) return [model.search.environment]
	const fallback = facetsReady(model) ? derivedDefaultEnvironment(model) : model.hint.environment
	return fallback === null ? undefined : [fallback]
}

/** `canFetch`: facets settled, or a prior load left a hint. */
export const canFetch = (model: Model): boolean => facetsReady(model) || model.hint.seen

export const ALL_ENVIRONMENTS = "__all__"

export const selectedEnvironment = (model: Model): string =>
	model.search.environment ?? (hasProduction(model) ? "production" : ALL_ENVIRONMENTS)

export const environmentItems = (model: Model): ReadonlyArray<{ value: string; label: string }> => [
	{ value: ALL_ENVIRONMENTS, label: "All environments" },
	...environmentsOf(model).map((name) => ({ value: name, label: name })),
]

/** The hint `FacetsHintPersister` writes once facets are ready. */
export const derivedHint = (model: Model): FacetsHint => ({
	environment: derivedDefaultEnvironment(model),
	preset: defaultPreset(model),
	seen: true,
})

// The label and metric of each anomaly signal.
const ANOMALY_LABEL = new Map<AnomalySignalType, string>([
	["error_rate", "Error rate anomaly"],
	["latency_p95", "Latency anomaly"],
	["throughput", "Traffic outage"],
	["error_spike", "Error frequency increase"],
	["log_volume", "Log volume anomaly"],
])
const ANOMALY_METRIC = new Map<AnomalySignalType, ServiceHealthCause["metric"]>([
	["error_rate", "error"],
	["latency_p95", "latency"],
	["throughput", "traffic"],
	["log_volume", "error"],
])

/** An ISO-8601 instant in epoch ms; `NaN` when unparseable, like `Date.parse`. */
const isoMs = (iso: string): number =>
	Option.match(DateTime.make(iso), { onNone: () => Number.NaN, onSome: DateTime.toEpochMillis })

// copied: `anomalyAffectsServiceHealth` (anomaly-format.ts holds icons); every count row is open.
const ANOMALY_STALE_AFTER_MS = 60 * 60 * 1000
const affectsHealth = (row: V2AnomalyServiceCount, nowMs: number): boolean => {
	const lastTriggeredMs = isoMs(row.last_triggered_at)
	const isStale = !Number.isFinite(lastTriggeredMs) || nowMs - lastTriggeredMs > ANOMALY_STALE_AFTER_MS
	return row.signal_type !== "error_spike" && !isStale
}

export interface EnrichedService {
	readonly service: HealthSnapshot
	readonly health: ServiceHealth
	readonly causes: ReadonlyArray<ServiceHealthCause>
}

/** `enrichServices`: alert and anomaly causes per row, worst health first, then error rate. */
export const enrichServices = (
	services: ReadonlyArray<HealthSnapshot>,
	incidents: ReadonlyArray<Incident>,
	anomalies: ReadonlyArray<V2AnomalyServiceCount>,
	nowMs: number,
): Array<EnrichedService> =>
	services
		.map((service) => {
			const alertCauses: Array<ServiceHealthCause> = incidents
				.filter((incident) => incident.status === "open" && incident.groupKey === service.serviceName)
				.map((incident) => ({ severity: incident.severity, label: "Alert firing" }))
			const anomalyCauses: Array<ServiceHealthCause> = anomalies
				.filter(
					(row) =>
						affectsHealth(row, nowMs) &&
						row.service_name === service.serviceName &&
						(row.deployment_env || "unknown") === service.environment,
				)
				.map((row) => ({
					severity: row.severity,
					label: ANOMALY_LABEL.get(row.signal_type) ?? "",
					metric: ANOMALY_METRIC.get(row.signal_type),
					direction: anomalyDirection(row.signal_type),
				}))
			const causes = [...alertCauses, ...anomalyCauses].sort((a, b) =>
				a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1,
			)
			return { service, causes, health: deriveServiceHealthFromCauses(causes) }
		})
		.sort(
			(a, b) =>
				healthRank(b.health) - healthRank(a.health) || b.service.errorRate - a.service.errorRate,
		)

export const countByHealth = (services: ReadonlyArray<EnrichedService>): Record<ServiceHealth, number> => ({
	healthy: services.filter((entry) => entry.health === "healthy").length,
	degraded: services.filter((entry) => entry.health === "degraded").length,
	unhealthy: services.filter((entry) => entry.health === "unhealthy").length,
})
