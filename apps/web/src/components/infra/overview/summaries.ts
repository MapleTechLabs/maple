// Per-source health for the /infra overview, as pure functions over the rows
// each source's own list page already fetches. Nothing here queries: the
// overview reads the same atoms the list pages do, so the numbers agree.

import type { CloudflareZoneRow } from "@/api/warehouse/cloudflare-infra"
import type { RailwayServiceRow } from "@/api/warehouse/railway-infra"
import type { PlanetScaleDatabaseStat } from "@/api/warehouse/service-map"
import { formatPercent } from "@maple/ui/lib/format"

import { errorRateTone } from "../cloudflare/constants"
import type { ContainerScopeCounts } from "../container-summary-band"
import { HOST_LIST_LIMIT, countHostScopes, hostPeak } from "../host-summary-band"
import type { HostRow } from "../host-table"
import { formatLag, formatStoragePercent, lagTone, utilizationTone } from "../planetscale/metrics"
import { railwayInScope } from "../railway/railway-service-table"
import type { Tone } from "../severity-tokens"

export type SourceId = "hosts" | "containers" | "kubernetes" | "cloudflare" | "railway" | "planetscale"

export type FindingTone = "crit" | "warn" | "stale"

/** Where a finding opens. A union rather than a URL so every link stays route-checked. */
export type FindingTarget =
	| { kind: "hosts"; scope: "saturated" | "elevated" | "stale" }
	| { kind: "host"; hostName: string }
	| { kind: "containers"; scope: "saturated" | "elevated" | "stale" }
	| { kind: "pods"; scope: "saturated" | "elevated" | "unbounded" }
	| { kind: "zone"; zoneName: string }
	| { kind: "railway"; serviceId: string; environmentId: string }
	| { kind: "planetscale"; database: string }

export interface Finding {
	readonly key: string
	readonly source: SourceId
	readonly tone: FindingTone
	readonly title: string
	readonly detail: string
	readonly target: FindingTarget
}

export interface HealthSegment {
	/** `unbounded`: no limit to measure against, so neither ok nor at risk. */
	readonly key: "ok" | "elevated" | "saturated" | "unbounded"
	readonly count: number
}

export interface SourceSummary {
	/** "24 hosts". */
	readonly resources: string
	readonly segments: ReadonlyArray<HealthSegment>
	readonly headline: string
	readonly headlineTone: "neutral" | "warn" | "crit"
	readonly findings: ReadonlyArray<Finding>
}

/** Rows a single source contributes before it summarizes the rest into one line. */
const MAX_FINDINGS_PER_SOURCE = 3

const plural = (count: number, noun: string) => `${count.toLocaleString()} ${count === 1 ? noun : `${noun}s`}`

const okCount = (total: number, ...flagged: number[]) =>
	Math.max(total - flagged.reduce((sum, n) => sum + n, 0), 0)

const worstTone = (findings: ReadonlyArray<Finding>): SourceSummary["headlineTone"] =>
	findings.some((f) => f.tone === "crit")
		? "crit"
		: findings.some((f) => f.tone === "warn")
			? "warn"
			: "neutral"

const METRIC_NAMES = ["CPU", "memory", "disk"] as const

export function summarizeHosts(hosts: ReadonlyArray<HostRow>, referenceTime: string): SourceSummary {
	const { total, saturated, elevated, stale } = countHostScopes(hosts, referenceTime)
	const byPeak = [...hosts].sort((a, b) => hostPeak(b) - hostPeak(a))
	const hot = byPeak.filter((host) => hostPeak(host) >= 0.9)

	const findings: Finding[] = hot.slice(0, MAX_FINDINGS_PER_SOURCE).map((host) => {
		const values = [host.cpuPct, host.memoryPct, host.diskPct]
		const worst = values.indexOf(Math.max(...values))
		return {
			key: `host:${host.hostName}`,
			source: "hosts",
			tone: "crit",
			title: `${host.hostName} at ${formatPercent(values[worst] ?? 0)} ${METRIC_NAMES[worst]}`,
			detail: `CPU ${formatPercent(host.cpuPct)}, memory ${formatPercent(host.memoryPct)}, disk ${formatPercent(host.diskPct)}`,
			target: { kind: "host", hostName: host.hostName },
		}
	})
	if (hot.length > MAX_FINDINGS_PER_SOURCE) {
		findings.push({
			key: "hosts:saturated-rest",
			source: "hosts",
			tone: "crit",
			title: `${plural(hot.length - MAX_FINDINGS_PER_SOURCE, "more host")} at 90% or above`,
			detail: "Busiest of CPU, memory and disk",
			target: { kind: "hosts", scope: "saturated" },
		})
	}
	if (stale > 0) {
		findings.push({
			key: "hosts:stale",
			source: "hosts",
			tone: "stale",
			title: `${plural(stale, "host")} stopped reporting`,
			detail: "No metrics in the last 5 minutes of the window. The collector or the host is down.",
			target: { kind: "hosts", scope: "stale" },
		})
	}

	const busiest = byPeak[0]
	return {
		// At the cap the list is a sample, so the count is a floor.
		resources: total >= HOST_LIST_LIMIT ? `${total.toLocaleString()}+ hosts` : plural(total, "host"),
		segments: [
			{ key: "ok", count: okCount(total, saturated, elevated) },
			{ key: "elevated", count: elevated },
			{ key: "saturated", count: saturated },
		],
		headline: busiest ? `busiest ${busiest.hostName} at ${formatPercent(hostPeak(busiest))}` : "no hosts",
		headlineTone: worstTone(findings),
		findings,
	}
}

export function summarizeContainers(counts: ContainerScopeCounts): SourceSummary {
	const { totalContainers, saturatedContainers, elevatedContainers, staleContainers } = counts
	const findings: Finding[] = []
	if (saturatedContainers > 0) {
		findings.push({
			key: "containers:saturated",
			source: "containers",
			tone: "crit",
			title: `${plural(saturatedContainers, "container")} at 90% of CPU or memory limit`,
			detail: "Peak utilization against each container's own limit",
			target: { kind: "containers", scope: "saturated" },
		})
	}
	if (staleContainers > 0) {
		findings.push({
			key: "containers:stale",
			source: "containers",
			tone: "stale",
			title: `${plural(staleContainers, "container")} stopped reporting`,
			detail: "The Docker agent beside them has gone quiet",
			target: { kind: "containers", scope: "stale" },
		})
	}
	return {
		resources: plural(totalContainers, "container"),
		segments: [
			{ key: "ok", count: okCount(totalContainers, saturatedContainers, elevatedContainers) },
			{ key: "elevated", count: elevatedContainers },
			{ key: "saturated", count: saturatedContainers },
		],
		headline:
			saturatedContainers + elevatedContainers > 0
				? `${plural(saturatedContainers + elevatedContainers, "container")} above 60%`
				: "all under 60% of limit",
		headlineTone: worstTone(findings),
		findings,
	}
}

export interface PodCounts {
	readonly livePods: number
	readonly endedPods: number
	readonly saturatedPods: number
	readonly elevatedPods: number
	readonly unboundedPods: number
}

export function summarizePods(counts: PodCounts): SourceSummary {
	const { livePods, saturatedPods, elevatedPods, unboundedPods } = counts
	const findings: Finding[] = []
	if (saturatedPods > 0) {
		findings.push({
			key: "pods:saturated",
			source: "kubernetes",
			tone: "crit",
			title: `${plural(saturatedPods, "pod")} at their CPU or memory limit`,
			detail: "Peak use at or above 90% of the limit",
			target: { kind: "pods", scope: "saturated" },
		})
	}
	if (unboundedPods > 0) {
		findings.push({
			key: "pods:unbounded",
			source: "kubernetes",
			tone: "warn",
			title: `${plural(unboundedPods, "pod")} running with no limits`,
			detail: "Nothing stops them from starving their neighbours",
			target: { kind: "pods", scope: "unbounded" },
		})
	}
	return {
		resources: plural(livePods, "live pod"),
		segments: [
			{ key: "ok", count: okCount(livePods, saturatedPods, elevatedPods) },
			{ key: "elevated", count: elevatedPods },
			{ key: "saturated", count: saturatedPods },
		],
		headline: saturatedPods > 0 ? `${plural(saturatedPods, "pod")} at limit` : "no pod at its limit",
		headlineTone: worstTone(findings),
		findings,
	}
}

/** Zones with fewer requests than this can't move an error rate meaningfully. */
const MIN_ZONE_REQUESTS = 100

const compactCount = (n: number) =>
	n.toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 1 })

export function summarizeCloudflare(zones: ReadonlyArray<CloudflareZoneRow>): SourceSummary {
	const erroring = zones
		.filter((zone) => zone.requests >= MIN_ZONE_REQUESTS && errorRateTone(zone.errorRate) !== "neutral")
		.sort((a, b) => b.errorRate - a.errorRate)
	const crit = erroring.filter((zone) => errorRateTone(zone.errorRate) === "crit").length

	const findings: Finding[] = erroring.slice(0, MAX_FINDINGS_PER_SOURCE).map((zone) => ({
		key: `zone:${zone.zoneName}`,
		source: "cloudflare",
		tone: errorRateTone(zone.errorRate) === "crit" ? "crit" : "warn",
		title: `${zone.zoneName} returning ${formatPercent(zone.errorRate)} 5xx`,
		detail: `${compactCount(zone.requests)} requests, origin p99 ${Math.round(zone.originP99Ms)}ms`,
		target: { kind: "zone", zoneName: zone.zoneName },
	}))

	let requests = 0
	let cacheHits = 0
	for (const zone of zones) {
		requests += zone.requests
		cacheHits += zone.cacheHits
	}
	return {
		resources: plural(zones.length, "zone"),
		segments: [
			{ key: "ok", count: okCount(zones.length, erroring.length) },
			{ key: "elevated", count: erroring.length - crit },
			{ key: "saturated", count: crit },
		],
		headline: `${compactCount(requests)} requests, ${formatPercent(requests > 0 ? cacheHits / requests : 0)} cached`,
		headlineTone: worstTone(findings),
		findings,
	}
}

export function summarizeRailway(services: ReadonlyArray<RailwayServiceRow>): SourceSummary {
	const saturated = services.filter((row) => railwayInScope(row, "saturated"))
	const elevated = services.filter((row) => railwayInScope(row, "elevated")).length
	const unbounded = services.filter((row) => railwayInScope(row, "unbounded")).length
	const findings: Finding[] = saturated.slice(0, MAX_FINDINGS_PER_SOURCE).map((row) => ({
		key: `railway:${row.environmentId}:${row.serviceId}`,
		source: "railway",
		tone: "crit",
		title: `${row.serviceName || row.serviceId} at its resource limit`,
		detail: `${row.projectName} / ${row.environmentName}`,
		target: { kind: "railway", serviceId: row.serviceId, environmentId: row.environmentId },
	}))
	return {
		resources: plural(services.length, "service"),
		segments: [
			{ key: "ok", count: okCount(services.length, saturated.length, elevated, unbounded) },
			{ key: "elevated", count: elevated },
			{ key: "saturated", count: saturated.length },
			{ key: "unbounded", count: unbounded },
		],
		headline:
			saturated.length + elevated > 0
				? `${plural(saturated.length + elevated, "service")} above 60% of limit`
				: "all under 60% of limit",
		headlineTone: worstTone(findings),
		findings,
	}
}

/** PlanetScale tones a gauge `neutral` when it's fine; only warn and crit become findings. */
const findingTone = (tone: Tone): "crit" | "warn" | undefined =>
	tone === "crit" || tone === "warn" ? tone : undefined

export function summarizePlanetScale(databases: ReadonlyArray<PlanetScaleDatabaseStat>): SourceSummary {
	const findings: Finding[] = []
	let elevated = 0
	let saturated = 0
	for (const db of databases) {
		const gauges = [
			{
				id: "lag",
				tone: findingTone(lagTone(db.replicaLagMaxSeconds)),
				title: `${db.database} replica ${formatLag(db.replicaLagMaxSeconds)} behind primary`,
				detail: "Peak replica lag in the window",
			},
			{
				id: "cpu",
				tone: findingTone(utilizationTone(db.cpuMaxPercent)),
				title: `${db.database} CPU peaked at ${formatPercent(db.cpuMaxPercent / 100)}`,
				detail: "Busiest branch in the window",
			},
			{
				id: "memory",
				tone: findingTone(utilizationTone(db.memMaxPercent)),
				title: `${db.database} memory peaked at ${formatPercent(db.memMaxPercent / 100)}`,
				detail: "Busiest branch in the window",
			},
			{
				id: "storage",
				tone:
					db.storageUsedPercent === null
						? undefined
						: findingTone(utilizationTone(db.storageUsedPercent)),
				title: `${db.database} storage at ${formatStoragePercent(db.storageUsedPercent ?? 0)}`,
				detail: "Share of the plan's storage in use",
			},
		] as const
		if (gauges.some((gauge) => gauge.tone === "crit")) saturated++
		else if (gauges.some((gauge) => gauge.tone === "warn")) elevated++
		for (const gauge of gauges) {
			if (!gauge.tone) continue
			findings.push({
				key: `planetscale:${db.database}:${gauge.id}`,
				source: "planetscale",
				tone: gauge.tone,
				title: gauge.title,
				detail: gauge.detail,
				target: { kind: "planetscale", database: db.database },
			})
		}
	}
	findings.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === "crit" ? -1 : 1))
	const worstLag = databases.reduce<PlanetScaleDatabaseStat | undefined>(
		(worst, db) =>
			worst === undefined || db.replicaLagMaxSeconds > worst.replicaLagMaxSeconds ? db : worst,
		undefined,
	)
	return {
		resources: plural(databases.length, "database"),
		segments: [
			{ key: "ok", count: okCount(databases.length, saturated, elevated) },
			{ key: "elevated", count: elevated },
			{ key: "saturated", count: saturated },
		],
		headline: worstLag ? `worst replica lag ${formatLag(worstLag.replicaLagMaxSeconds)}` : "no databases",
		headlineTone: worstTone(findings),
		findings: findings.slice(0, MAX_FINDINGS_PER_SOURCE),
	}
}
