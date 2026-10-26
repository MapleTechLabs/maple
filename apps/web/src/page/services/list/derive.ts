import type { V2AnomalyServiceCount } from "@maple/domain/http/v2"
import {
	baselineKey,
	alertIncidentCauseLabel,
	buildBaselineMap,
	deriveServiceHealthFromCauses,
	type LatencyBaselineSignal,
	type ServiceHealth,
	type ServiceHealthCause,
} from "../../../components/dashboard/service-health"
import { DateTime, Option } from "effect"
import type { ServicesSearch } from "../../../route/search"
import type { IncidentCause, ServiceRow } from "./model"

// Pure derivations of the services table and its health summary.

export type Search = typeof ServicesSearch.Type
export type { ServiceHealth }

export const serviceHealthRowKey = (serviceName: string, environment: string) =>
	`${serviceName}::${environment}`

export const HEALTH_LEVELS: ReadonlyArray<ServiceHealth> = ["unhealthy", "degraded", "healthy"]
export const isServiceHealth = (value: string): value is ServiceHealth =>
	HEALTH_LEVELS.some((level) => level === value)

export type HealthSummary = Readonly<{
	byRow: ReadonlyMap<string, ServiceHealth>
	/** Why each row has its health, for the hover; empty for a healthy row. */
	causesByRow: ReadonlyMap<string, ReadonlyArray<ServiceHealthCause>>
	counts: Readonly<Record<ServiceHealth, number>>
}>

/** An ISO-8601 instant in epoch ms; `NaN` when unparseable, like `Date.parse`. */
export const isoMs = (iso: string): number =>
	Option.match(DateTime.make(iso), { onNone: () => Number.NaN, onSome: DateTime.toEpochMillis })

// copied: anomaly-format.ts (`isStaleOpenIncident`, `anomalyAffectsServiceHealth`); that module holds icons.
const ANOMALY_STALE_AFTER_MS = 60 * 60 * 1000
const anomalyAffectsHealth = (row: V2AnomalyServiceCount, nowMs: number): boolean => {
	const lastTriggeredMs = isoMs(row.last_triggered_at)
	const isStale = !Number.isFinite(lastTriggeredMs) || nowMs - lastTriggeredMs > ANOMALY_STALE_AFTER_MS
	return row.signal_type !== "error_spike" && !isStale
}

/** `useServiceHealthSummary`: alert incidents by service name, open anomalies by service and environment. */
export const healthSummary = (
	overview: ReadonlyArray<ServiceRow>,
	incidents: ReadonlyArray<IncidentCause>,
	anomalies: ReadonlyArray<V2AnomalyServiceCount>,
	nowMs: number,
): HealthSummary => {
	const alertCauses = new Map<string, Array<ServiceHealthCause>>()
	incidents
		.filter(
			(incident) =>
				incident.status === "open" && incident.groupKey !== null && incident.groupKey !== "",
		)
		.forEach((incident) => {
			const key = incident.groupKey ?? ""
			alertCauses.set(key, [
				...(alertCauses.get(key) ?? []),
				{
					severity: incident.severity,
					label: alertIncidentCauseLabel(incident.signalType),
				},
			])
		})
	const anomalyCauses = new Map<string, Array<ServiceHealthCause>>()
	anomalies
		.filter((row) => anomalyAffectsHealth(row, nowMs))
		.forEach((row) => {
			const key = serviceHealthRowKey(row.service_name, row.deployment_env || "unknown")
			anomalyCauses.set(key, [
				...(anomalyCauses.get(key) ?? []),
				{ severity: row.severity, label: "Anomaly" },
			])
		})
	const byRow = new Map<string, ServiceHealth>()
	const causesByRow = new Map<string, ReadonlyArray<ServiceHealthCause>>()
	const counts = { healthy: 0, degraded: 0, unhealthy: 0 }
	overview.forEach((service) => {
		const key = serviceHealthRowKey(service.serviceName, service.environment)
		const causes = [...(alertCauses.get(service.serviceName) ?? []), ...(anomalyCauses.get(key) ?? [])]
		const health = deriveServiceHealthFromCauses(causes)
		byRow.set(key, health)
		causesByRow.set(key, causes)
		counts[health] += 1
	})
	return { byRow, causesByRow, counts }
}

export const healthOf = (
	summary: HealthSummary | undefined,
	service: ServiceRow,
): ServiceHealth | undefined =>
	summary?.byRow.get(serviceHealthRowKey(service.serviceName, service.environment))

/** The rows the table shows: the overview, narrowed by the `health` search param. */
export const displayedServices = (
	overview: ReadonlyArray<ServiceRow>,
	summary: HealthSummary | undefined,
	search: Search,
): ReadonlyArray<ServiceRow> =>
	search.health === undefined
		? overview
		: overview.filter((service) => healthOf(summary, service) === search.health)

const SERVICE_FILTER_KEYS = [
	"environments",
	"namespaces",
	"commitShas",
	"excludedEnvironments",
	"excludedNamespaces",
	"excludedCommitShas",
	"health",
] as const

/** `hasActiveServiceFilters`: the params that can empty the table by themselves (not the window). */
export const hasActiveServiceFilters = (search: Search): boolean =>
	SERVICE_FILTER_KEYS.some((key) => {
		const value = search[key]
		return Array.isArray(value) ? value.length > 0 : value !== undefined
	})

export type GroupBy = "namespace" | "environment"

/** Unset `groupBy` is auto: by namespace once a row carries one, unless the org pins a namespace. */
export const resolveGroupBy = (
	explicit: GroupBy | undefined,
	services: ReadonlyArray<ServiceRow>,
	isNamespacePinned: boolean,
): GroupBy => {
	if (explicit !== undefined) return explicit
	if (isNamespacePinned) return "environment"
	return services.some((service) => service.serviceNamespace !== "") ? "namespace" : "environment"
}

const ENVIRONMENT_PRIORITY = new Map([
	["production", 0],
	["staging", 1],
	["development", 2],
])

type EnvGroup = readonly [environment: string, services: ReadonlyArray<ServiceRow>]
export type Group = readonly [namespace: string, environments: ReadonlyArray<EnvGroup>]

/** Sentinel group key for rows without a `service.namespace`; sorted last. */
export const NO_NAMESPACE = ""

const groupBy = (services: ReadonlyArray<ServiceRow>, keyOf: (service: ServiceRow) => string) => {
	const groups = new Map<string, Array<ServiceRow>>()
	services.forEach((service) => {
		const key = keyOf(service)
		groups.set(key, [...(groups.get(key) ?? []), service])
	})
	return Array.from(groups.entries())
}

const groupByEnvironment = (services: ReadonlyArray<ServiceRow>): ReadonlyArray<EnvGroup> =>
	groupBy(services, (service) => service.environment).toSorted(([a], [b]) => {
		const pa = ENVIRONMENT_PRIORITY.get(a.toLowerCase()) ?? (a === "unknown" ? 999 : 3)
		const pb = ENVIRONMENT_PRIORITY.get(b.toLowerCase()) ?? (b === "unknown" ? 999 : 3)
		return pa !== pb ? pa - pb : a.localeCompare(b)
	})

/** Namespace mode nests environment groups; environment mode is one anonymous outer group. */
export const groupServices = (services: ReadonlyArray<ServiceRow>, mode: GroupBy): ReadonlyArray<Group> =>
	mode === "namespace"
		? groupBy(services, (service) => service.serviceNamespace || NO_NAMESPACE)
				.toSorted(([a], [b]) =>
					a === NO_NAMESPACE ? 1 : b === NO_NAMESPACE ? -1 : a.localeCompare(b),
				)
				.map(([namespace, rows]) => [namespace, groupByEnvironment(rows)] as const)
		: [[NO_NAMESPACE, groupByEnvironment(services)]]

// DEPLOY CELL

const MIN_DEPLOY_COMPARE_SPANS = 50
const ROLLOUT_MIN_SHARE_PCT = 5

type Commit = ServiceRow["commits"][number]

export type DeployInfo = Readonly<{
	sha: string
	firstSeen: string
	rollout: Readonly<{ percentage: number; others: ReadonlyArray<Commit> }> | undefined
	errorsSince: boolean
}>

/** `deriveDeployInfo`: the newest commit, a mid-rollout split, and errors up since the deploy. */
export const deployInfo = (commits: ReadonlyArray<Commit>): DeployInfo | undefined => {
	const real = commits.filter((c) => c.commitSha && c.commitSha !== "N/A" && c.commitSha !== "unknown")
	const [first] = real
	if (first === undefined) return undefined
	const dated = real.filter((c) => c.firstSeen !== "")
	const pool = dated.length > 0 ? dated : real
	const latest = pool.reduce((best, c) => (c.firstSeen > best.firstSeen ? c : best))
	const dominant = real.reduce((best, c) => (c.spanCount > best.spanCount ? c : best))
	const previous = pool
		.filter((c) => c.firstSeen < latest.firstSeen)
		.reduce<Commit | undefined>(
			(best, c) => (best === undefined || c.firstSeen > best.firstSeen ? c : best),
			undefined,
		)
	const olderSpans = previous?.spanCount ?? 0
	const latestRate = latest.spanCount > 0 ? latest.errorCount / latest.spanCount : 0
	const olderRate = previous !== undefined && olderSpans > 0 ? previous.errorCount / olderSpans : 0
	const errorsSince =
		latest.spanCount >= MIN_DEPLOY_COMPARE_SPANS &&
		olderSpans >= MIN_DEPLOY_COMPARE_SPANS &&
		latestRate >= olderRate * 2 &&
		latestRate - olderRate >= 0.005
	const meaningful = real.filter((c) => c.percentage >= ROLLOUT_MIN_SHARE_PCT)
	const rollout =
		meaningful.length > 1
			? {
					percentage: dominant.percentage,
					others: real
						.filter((c) => c !== dominant)
						.toSorted((a, b) => b.percentage - a.percentage),
				}
			: undefined
	return { sha: latest.commitSha, firstSeen: latest.firstSeen, rollout, errorsSince }
}

const FULL_SHA = /^[0-9a-f]{40}$/i
export const isResolvableSha = (sha: string): boolean => FULL_SHA.test(sha)

/** `commitsQueryKey`: the deduped, sorted resolvable shas of the rows on screen; "" means no request. */
export const commitsKey = (services: ReadonlyArray<ServiceRow>): string =>
	[
		...new Set(
			services.flatMap((service) => {
				const sha = deployInfo(service.commits)?.sha
				return sha === undefined ? [] : [sha]
			}),
		),
	]
		.filter(isResolvableSha)
		.toSorted()
		.join(",")

// LATENCY BASELINE

const MIN_BASELINE_SPANS = 100

export type BaselineDelta = Readonly<{ label: string; className: string }>

export const baselineMapOf = buildBaselineMap
export { baselineKey }

/** `baselineDelta`: the p95 against the trailing 7 days, withheld on thin baselines. */
export const baselineDelta = (
	p95LatencyMs: number,
	baseline: LatencyBaselineSignal | undefined,
): BaselineDelta | undefined => {
	if (baseline === undefined || baseline.spanCount < MIN_BASELINE_SPANS || baseline.p95LatencyMs <= 0) {
		return undefined
	}
	const delta = (p95LatencyMs - baseline.p95LatencyMs) / baseline.p95LatencyMs
	const pct = Math.round(delta * 100)
	return {
		label: `${pct > 0 ? "+" : ""}${pct}% vs 7d`,
		className:
			delta >= 1
				? "text-severity-error"
				: delta >= 0.25
					? "text-severity-warn"
					: "text-muted-foreground",
	}
}
