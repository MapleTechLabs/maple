import type { AnomalyIncidentDocument, AnomalySignalType } from "@maple/domain/http"
import {
	anomalyFilterChips,
	hasAnomalyFilters,
	matchesAnomalyFilters,
	type AnomalyFilters,
} from "../../../lib/anomalies/anomaly-filters"
import { anomalyIncidentFromV2 } from "../../../lib/services/anomalies"
import { SIGNAL_LABEL } from "@maple/web-data/anomalies/format"
import { AsyncData } from "foldkit"
import type { AnomaliesSearch } from "../../../route/search"
import type { GroupKey, Model, StatusTab } from "./model"

export type Search = typeof AnomaliesSearch.Type

export const statusOf = (search: Search): StatusTab => search.status ?? "open"
export const isLiveOf = (search: Search): boolean => search.live ?? statusOf(search) === "open"

export const filtersOf = (search: Search): AnomalyFilters => ({
	severity: search.severity,
	signals: search.signals,
	services: search.services,
	envs: search.envs,
	excludedSeverity: search.excludedSeverity,
	excludedSignals: search.excludedSignals,
	excludedServices: search.excludedServices,
	excludedEnvs: search.excludedEnvs,
})

export { anomalyFilterChips, hasAnomalyFilters }

/** The first page plus "Load more" pages for this tab, deduped by id (first page wins). */
export const allIncidentsOf = (model: Model): ReadonlyArray<AnomalyIncidentDocument> => {
	const first = AsyncData.getOrElse(model.firstPage.data, () => null)
	const firstRows = first === null ? [] : first.data.map(anomalyIncidentFromV2)
	const pages = model.loadedPages?.key === statusOf(model.search) ? model.loadedPages : null
	if (pages === null) return firstRows
	const byId = new Map(firstRows.map((incident) => [incident.id, incident]))
	pages.rows.map(anomalyIncidentFromV2).forEach((incident) => {
		if (!byId.has(incident.id)) byId.set(incident.id, incident)
	})
	return [...byId.values()]
}

/**
 * The cursor "Load more" continues from: none while a tab switch keeps the previous tab's first
 * page on screen (`retained`), so a load-more never pairs the new tab with the old tab's cursor.
 */
export const nextCursorOf = (model: Model): string | null => {
	if (model.firstPage.retained === true) return null
	const pages = model.loadedPages?.key === statusOf(model.search) ? model.loadedPages : null
	if (pages !== null) return pages.nextCursor
	return AsyncData.getOrElse(model.firstPage.data, () => null)?.nextCursor ?? null
}

export const filteredOf = (model: Model, all: ReadonlyArray<AnomalyIncidentDocument>) => {
	const filters = filtersOf(model.search)
	return all.filter((incident) => matchesAnomalyFilters(incident, filters))
}

export const GROUP_ORDER: ReadonlyArray<GroupKey> = ["critical", "warning", "resolved"]
export const GROUP_LABEL = { critical: "Critical", warning: "Warning", resolved: "Resolved" } as const

export const groupKeyOf = (incident: AnomalyIncidentDocument): GroupKey =>
	incident.status !== "open" ? "resolved" : incident.severity

const clusterKey = (incident: AnomalyIncidentDocument) =>
	`${incident.serviceName}\u0000${incident.deploymentEnv}`

/** Buckets by group; each bucket clusters by service+env, clusters by freshest incident. */
export const groupIncidents = (
	incidents: ReadonlyArray<AnomalyIncidentDocument>,
): ReadonlyArray<readonly [GroupKey, ReadonlyArray<AnomalyIncidentDocument>]> =>
	GROUP_ORDER.flatMap((group) => {
		const bucket = incidents.filter((incident) => groupKeyOf(incident) === group)
		if (bucket.length === 0) return []
		const latest = new Map<string, string>()
		bucket.forEach((incident) => {
			const current = latest.get(clusterKey(incident))
			if (current === undefined || incident.lastTriggeredAt.localeCompare(current) > 0)
				latest.set(clusterKey(incident), incident.lastTriggeredAt)
		})
		const sorted = bucket.toSorted((a, b) => {
			const clusterA = latest.get(clusterKey(a)) ?? ""
			const clusterB = latest.get(clusterKey(b)) ?? ""
			if (clusterA !== clusterB) return clusterB.localeCompare(clusterA)
			const keyCompare = clusterKey(a).localeCompare(clusterKey(b))
			if (keyCompare !== 0) return keyCompare
			return b.lastTriggeredAt.localeCompare(a.lastTriggeredAt)
		})
		return [[group, sorted] as const]
	})

export interface ServiceCluster {
	readonly key: string
	readonly serviceName: string
	readonly deploymentEnv: string
	readonly incidents: ReadonlyArray<AnomalyIncidentDocument>
}

/** `clusterByService`: consecutive same-service runs. */
export const clusterByService = (
	incidents: ReadonlyArray<AnomalyIncidentDocument>,
): ReadonlyArray<ServiceCluster> =>
	incidents.reduce<ReadonlyArray<ServiceCluster>>((clusters, incident) => {
		const key = clusterKey(incident)
		const last = clusters[clusters.length - 1]
		return last !== undefined && last.key === key
			? [...clusters.slice(0, -1), { ...last, incidents: [...last.incidents, incident] }]
			: [
					...clusters,
					{
						key,
						serviceName: incident.serviceName,
						deploymentEnv: incident.deploymentEnv,
						incidents: [incident],
					},
				]
	}, [])

const SEVERITY_LABEL = { critical: "Critical", warning: "Warning" } as const

const byCount = <K>(entries: ReadonlyArray<K>): ReadonlyArray<readonly [K, number]> => {
	const counts = new Map<K, number>()
	entries.forEach((entry) => counts.set(entry, (counts.get(entry) ?? 0) + 1))
	return [...counts.entries()].toSorted((a, b) => b[1] - a[1])
}

/** The sidebar facets, derived from the unfiltered incidents of the tab. */
export const facetsOf = (incidents: ReadonlyArray<AnomalyIncidentDocument>) => {
	const severity = byCount(incidents.map((incident) => incident.severity))
	const signals = byCount(incidents.map((incident) => incident.signalType))
	return {
		severity,
		signals,
		services: byCount(incidents.map((incident) => incident.serviceName)),
		envs: byCount(
			incidents
				.filter((incident) => incident.deploymentEnv !== "")
				.map((incident) => incident.deploymentEnv),
		),
		severityLabel: (name: string) =>
			name === "critical" || name === "warning" ? SEVERITY_LABEL[name] : name,
		signalLabel: (name: string) => {
			const entry = signals.find(([signal]) => signal === name)
			return entry === undefined ? name : SIGNAL_LABEL[entry[0] satisfies AnomalySignalType]
		},
	}
}
