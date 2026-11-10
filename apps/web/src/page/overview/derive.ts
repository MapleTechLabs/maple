import type { V2AnomalyServiceCount } from "@maple/domain/http/v2"
import {
	deriveServiceHealthFromCauses,
	healthRank,
	type ServiceHealth,
	type ServiceHealthCause,
} from "../../components/dashboard/service-health"
import { Option, Array as Arr, String as Str } from "effect"
import { AsyncData } from "foldkit"
import { isPresetValue, type PresetValue } from "../kit/time-controls"
import { type HealthIncident, serviceHealthCauses } from "../kit/service-health"
import type { FacetsHint, HealthSnapshot, Model } from "./model"

// Pure derivations of the home page (`defaultPreset`, `environmentFilter`) and its service health
// section (`enrichServices`, `countByHealth`).

export type { ServiceHealth, ServiceHealthCause }

/** `defaultPreset`: the hint's preset until facets resolve (when it is still a rail preset); 6h for
 * all-demo orgs, else 24h. */
export const defaultPreset = (model: Model): PresetValue =>
	Option.match(AsyncData.getData(model.facets.data), {
		onNone: () => (isPresetValue(model.hint.preset) ? model.hint.preset : "24h"),
		onSome: ({ services }) =>
			services.length === 0
				? "24h"
				: Arr.every(services, (name) => Str.startsWith("demo-")(name))
					? "6h"
					: "24h",
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
	...Arr.map(environmentsOf(model), (name) => ({ value: name, label: name })),
]

/** The hint `FacetsHintPersister` writes once facets are ready. */
export const derivedHint = (model: Model): FacetsHint => ({
	environment: derivedDefaultEnvironment(model),
	preset: defaultPreset(model),
	seen: true,
})

export interface EnrichedService {
	readonly service: HealthSnapshot
	readonly health: ServiceHealth
	readonly causes: ReadonlyArray<ServiceHealthCause>
}

/** `enrichServices`: alert and anomaly causes per row, worst health first, then error rate. */
export const enrichServices = (
	services: ReadonlyArray<HealthSnapshot>,
	incidents: ReadonlyArray<HealthIncident>,
	anomalies: ReadonlyArray<V2AnomalyServiceCount>,
	nowMs: number,
): Array<EnrichedService> => {
	const causesOf = serviceHealthCauses(incidents, anomalies, nowMs, { dropEmptyGroupKey: false })
	return Arr.map(services, (service) => {
		const causes = [...causesOf(service.serviceName, service.environment)].sort((a, b) =>
			a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1,
		)
		return { service, causes, health: deriveServiceHealthFromCauses(causes) }
	}).sort((a, b) =>
		healthRank(b.health) !== healthRank(a.health)
			? healthRank(b.health) - healthRank(a.health)
			: b.service.errorRate - a.service.errorRate,
	)
}

export const countByHealth = (services: ReadonlyArray<EnrichedService>): Record<ServiceHealth, number> => ({
	healthy: Arr.filter(services, (entry) => entry.health === "healthy").length,
	degraded: Arr.filter(services, (entry) => entry.health === "degraded").length,
	unhealthy: Arr.filter(services, (entry) => entry.health === "unhealthy").length,
})
