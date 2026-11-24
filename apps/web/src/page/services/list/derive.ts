import type { V2AnomalyServiceCount } from "@maple/domain/http/v2"
import {
	baselineKey,
	buildBaselineMap,
	deriveServiceHealthFromCauses,
	type LatencyBaselineSignal,
	type ServiceHealth,
} from "../../kit/service-health-rollup"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { Array as Arr, String as Str, Option, Order, Record as Rec } from "effect"
import { AsyncData } from "foldkit"
import type { ServicesSearch } from "../../../route/search"
import { type HealthIncident, serviceHealthCauses } from "../../kit/service-health"
import { isResolvableSha } from "../../kit/commit-card"
import { VCS_COMMIT_DETAILS_MAX_SHAS } from "@maple/domain/http"
import type { CommitSummary, Model, ServiceRow } from "./model"

// Pure derivations of the services table and its health summary.

export type Search = typeof ServicesSearch.Type
export type { ServiceHealth }

export const serviceHealthRowKey = (serviceName: string, environment: string) =>
	`${serviceName}::${environment}`

export const HEALTH_LEVELS: ReadonlyArray<ServiceHealth> = ["unhealthy", "degraded", "healthy"]
export const isServiceHealth = (value: string): value is ServiceHealth =>
	Arr.some(HEALTH_LEVELS, (level) => level === value)

export type HealthSummary = Readonly<{
	byRow: ReadonlyMap<string, ServiceHealth>
	counts: Readonly<Record<ServiceHealth, number>>
}>

/** Alert incidents by service name, open anomalies by service and environment. */
export const healthSummary = (
	overview: ReadonlyArray<ServiceRow>,
	incidents: ReadonlyArray<HealthIncident>,
	anomalies: ReadonlyArray<V2AnomalyServiceCount>,
	nowMs: number,
): HealthSummary => {
	const causesOf = serviceHealthCauses(incidents, anomalies, nowMs, { dropEmptyGroupKey: true })
	const byRow = new Map<string, ServiceHealth>()
	const counts = { healthy: 0, degraded: 0, unhealthy: 0 }
	Arr.forEach(overview, (service) => {
		const key = serviceHealthRowKey(service.serviceName, service.environment)
		const health = deriveServiceHealthFromCauses(causesOf(service.serviceName, service.environment))
		byRow.set(key, health)
		counts[health] += 1
	})
	return { byRow, counts }
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
		: Arr.filter(overview, (service) => healthOf(summary, service) === search.health)

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
	Arr.some(SERVICE_FILTER_KEYS, (key) => {
		const value = search[key]
		return Arr.isArray(value) ? value.length > 0 : value !== undefined
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
	return Arr.some(services, (service) => service.serviceNamespace !== "") ? "namespace" : "environment"
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
	Arr.forEach(services, (service) => {
		const key = keyOf(service)
		groups.set(key, [...(groups.get(key) ?? []), service])
	})
	return Array.from(groups.entries())
}

const groupByEnvironment = (services: ReadonlyArray<ServiceRow>): ReadonlyArray<EnvGroup> =>
	Arr.sort(
		groupBy(services, (service) => service.environment),
		Order.combine(
			Order.mapInput(
				Order.Number,
				([name]: readonly [string, unknown]) =>
					ENVIRONMENT_PRIORITY.get(Str.toLowerCase(name)) ?? (name === "unknown" ? 999 : 3),
			),
			([a]: readonly [string, unknown], [b]: readonly [string, unknown]) => Str.localeCompare(b)(a),
		),
	)

/** Namespace mode nests environment groups; environment mode is one anonymous outer group. */
export const groupServices = (services: ReadonlyArray<ServiceRow>, mode: GroupBy): ReadonlyArray<Group> =>
	mode === "namespace"
		? Arr.map(
				Arr.sort(
					groupBy(services, (service) => service.serviceNamespace || NO_NAMESPACE),
					([a]: readonly [string, unknown], [b]: readonly [string, unknown]) =>
						a === NO_NAMESPACE ? 1 : b === NO_NAMESPACE ? -1 : Str.localeCompare(b)(a),
				),
				([namespace, rows]) => [namespace, groupByEnvironment(rows)] as const,
			)
		: [[NO_NAMESPACE, groupByEnvironment(services)]]

/** The rows in the order the table draws them, group by group: what the list keys step over. */
export const orderedServices = (
	services: ReadonlyArray<ServiceRow>,
	mode: GroupBy,
): ReadonlyArray<ServiceRow> =>
	Arr.flatMap(groupServices(services, mode), ([, environments]) =>
		Arr.flatMap(environments, ([, rows]) => rows),
	)

const MIN_DEPLOY_COMPARE_SPANS = 50
const ROLLOUT_MIN_SHARE_PCT = 5

type Commit = ServiceRow["commits"][number]

export type DeployInfo = Readonly<{
	sha: string
	firstSeen: string
	rollout: Readonly<{ percentage: number; others: ReadonlyArray<Commit> }> | undefined
	errorsSince: boolean
}>

/** The newest commit, a mid-rollout split, and errors up since the deploy. */
export const deployInfo = (commits: ReadonlyArray<Commit>): DeployInfo | undefined => {
	const real = Arr.filter(
		commits,
		(c) => c.commitSha !== "" && c.commitSha !== "N/A" && c.commitSha !== "unknown",
	)
	const [first] = real
	if (first === undefined) return undefined
	const dated = Arr.filter(real, (c) => c.firstSeen !== "")
	const pool = dated.length > 0 ? dated : real
	// Seeded with `first`: it is `pool`'s head, or undated and so beaten by every dated commit.
	const latest = Arr.reduce(pool, first, (best, c) => (c.firstSeen > best.firstSeen ? c : best))
	const dominant = Arr.reduce(real, first, (best, c) => (c.spanCount > best.spanCount ? c : best))
	const previous = Arr.reduce<Commit, Commit | undefined>(
		Arr.filter(pool, (c) => c.firstSeen < latest.firstSeen),
		undefined,
		(best, c) => (best === undefined || c.firstSeen > best.firstSeen ? c : best),
	)
	const olderSpans = previous?.spanCount ?? 0
	const latestRate = latest.spanCount > 0 ? latest.errorCount / latest.spanCount : 0
	const olderRate = previous !== undefined && olderSpans > 0 ? previous.errorCount / olderSpans : 0
	const errorsSince =
		latest.spanCount >= MIN_DEPLOY_COMPARE_SPANS &&
		olderSpans >= MIN_DEPLOY_COMPARE_SPANS &&
		latestRate >= olderRate * 2 &&
		latestRate - olderRate >= 0.005
	const meaningful = Arr.filter(real, (c) => c.percentage >= ROLLOUT_MIN_SHARE_PCT)
	const rollout =
		meaningful.length > 1
			? {
					percentage: dominant.percentage,
					others: Arr.sort(
						Arr.filter(real, (c) => c !== dominant),
						Order.flip(Order.mapInput(Order.Number, (c: Commit) => c.percentage)),
					),
				}
			: undefined
	return { sha: latest.commitSha, firstSeen: latest.firstSeen, rollout, errorsSince }
}

/**
 * `commitsQueryKey`: one lookup for the deploy cells and the release facet, in priority order: the
 * deploy shas of the rows on screen (sorted, so a row reorder keeps the key), then `otherShas` as
 * given. Deduped, resolvable only, capped at the endpoint's batch size. The order is kept because
 * the server only probes the provider for the first few unstored shas. "" means no request.
 */
export const commitsKey = (
	services: ReadonlyArray<ServiceRow>,
	otherShas: ReadonlyArray<string> = [],
): string => {
	const deployShas = Arr.flatMap(services, (service) => {
		const sha = deployInfo(service.commits)?.sha
		return sha === undefined ? [] : [sha]
	})
	const wanted = Arr.filter(
		[...new Set([...Arr.sort(deployShas, Order.String), ...otherShas])],
		isResolvableSha,
	)
	return Arr.join(wanted.slice(0, VCS_COMMIT_DETAILS_MAX_SHAS), ",")
}

/** The resolved commits by sha; empty until the lookup lands, and when it fails. */
export const commitSummariesOf = (
	model: Pick<Model, "commitSummaries">,
): Readonly<Record<string, CommitSummary>> =>
	Option.getOrElse(AsyncData.getData(model.commitSummaries.data), () => ({}))

/**
 * `releaseLabeler`: a release's label is its commit subject once resolved (with the short sha when
 * another resolved commit shares the subject), else the short sha, else the raw value.
 */
export const releaseLabeler = (summaries: Readonly<Record<string, CommitSummary>>) => {
	const subjects = Arr.map(Rec.values(summaries), (summary) => summary.subject)
	const repeated = new Set(Arr.filter(subjects, (subject, index) => subjects.indexOf(subject) !== index))
	return (value: string): string => {
		const subject = summaries[value]?.subject ?? ""
		const short = Str.slice(0, 7)(value)
		if (subject !== "") return repeated.has(subject) ? `${subject} · ${short}` : subject
		return isResolvableSha(value) ? short : value
	}
}

/** The release facet's order: resolved commits newest first, then the rest by span count as the query sent them. */
export const releaseOptions = <O extends Readonly<{ name: string }>>(
	options: ReadonlyArray<O>,
	summaries: Readonly<Record<string, CommitSummary>>,
): ReadonlyArray<O> => {
	const committedAt = (option: O) => summaries[option.name]?.committedAt
	const known = Arr.filter(options, (option) => committedAt(option) !== undefined)
	const unknown = Arr.filter(options, (option) => committedAt(option) === undefined)
	return [
		...Arr.sort(known, Order.flip(Order.mapInput(Order.Number, (option: O) => committedAt(option) ?? 0))),
		...unknown,
	]
}

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

/**
 * Each point's count per second over the part of its bucket the window covers, so the bucket the
 * window ends inside reads at its real rate rather than spread over a full bucket.
 */
export const perSecondRates = (
	points: ReadonlyArray<Readonly<{ bucket: string; throughput: number }>>,
	window: Readonly<{ startMs: number; endMs: number; bucketSeconds: number }>,
): ReadonlyArray<number> =>
	Arr.map(points, (point) => {
		const bucketStart = toEpochMs(point.bucket)
		const coveredSeconds =
			(Math.min(bucketStart + window.bucketSeconds * 1000, window.endMs) -
				Math.max(bucketStart, window.startMs)) /
			1000
		return coveredSeconds > 0 ? point.throughput / coveredSeconds : 0
	})

/** The services listed once: their sparkline series (one per service) is that row's own data. */
export const singleRowServices = (rows: ReadonlyArray<ServiceRow>): ReadonlySet<string> => {
	const counts = Arr.reduce(rows, new Map<string, number>(), (acc, row) =>
		acc.set(row.serviceName, (acc.get(row.serviceName) ?? 0) + 1),
	)
	const single = Arr.filter(Arr.fromIterable(counts), ([, count]) => count === 1)
	return new Set(Arr.map(single, ([name]) => name))
}

/**
 * Which cell values a hovered sparkline point may replace. The series is per service and unweighted:
 * it stands in for a row only when the service has no other row, and its error rate only when the
 * row is unsampled (sampled rows show a weight-corrected rate the series cannot match).
 */
export const sparklineHoverScope = (
	service: ServiceRow,
	singleRows: ReadonlySet<string>,
): Readonly<{ throughput: boolean; errorRate: boolean }> => {
	const isOwnSeries = singleRows.has(service.serviceName)
	return { throughput: isOwnSeries, errorRate: isOwnSeries && !service.hasSampling }
}
