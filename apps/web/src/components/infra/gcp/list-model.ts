// The /infra/gcp list: which views show, one row per workload of each view, every row's worst
// signal, the band's scopes, the problems-first order and each project's share. Pure, so the route
// and the lab read the same rows.

import { gcpInfraMetrics, type GcpInfraServiceId } from "@maple/domain/gcp-infra"
import type { V2GcpConnector } from "@maple/domain/http/v2"
import { ERROR_RATE_WARN } from "@maple/ui/lib/error-rate"
import type { Tone } from "@maple/ui/lib/tone"

import { GCP_METRICS_STATUS, gcpMetricsState } from "../../integrations/gcp-connector-state"
import type { GcpCloudSqlInstance } from "./inventory"
import {
	GCP_MIN_EVENTS,
	GCP_RESOURCES_TAB,
	GCP_VIEWS,
	GCP_VIEW_SERVICES,
	gcpMetricReader,
	gcpWorkload,
	gcpWorkloadId,
	gcpWorkloadName,
	gcpWorkloadPoints,
	gcpWorkloadProject,
	gcpWorkloadRegion,
	serverErrors,
	unhealthy,
	type GcpMetricPoint,
	type GcpServiceView,
	type GcpView,
	type GcpWorkload,
} from "./tabs"

/** One service of the fleet read: see `getGcpInfraFleet`. */
export interface GcpFleetRead {
	readonly service: GcpInfraServiceId
	readonly points: ReadonlyArray<GcpMetricPoint>
	/** The service's query failed: its workloads are unknown, not absent. */
	readonly failed: boolean
}

/** A row of the sparkline query: see `gcpInfraSparklinesSQL`. */
export interface GcpSparklinePoint {
	readonly keys: ReadonlyArray<string>
	readonly bucket: string
	readonly metric: string
	readonly total: number
	readonly samples: number
}

/** Per workload (`gcpWorkloadId`) and metric, one value per bucket in time order. */
export type GcpSparks = ReadonlyMap<string, ReadonlyMap<string, ReadonlyArray<number>>>

export const NO_GCP_SPARKS: GcpSparks = new Map()

/** About 24 buckets over the window, in whole minutes: the poller stores one point per minute. */
export const GCP_SPARKLINE_BUCKETS = 24

const utcMs = (time: string) => Date.parse(time.includes("T") ? time : `${time.replace(" ", "T")}Z`)

export const gcpWindowSeconds = (startTime: string, endTime: string): number =>
	(utcMs(endTime) - utcMs(startTime)) / 1000

export function gcpSparklineBucketSeconds(startTime: string, endTime: string): number {
	const windowSeconds = gcpWindowSeconds(startTime, endTime)
	return Math.max(60, Math.ceil(windowSeconds / GCP_SPARKLINE_BUCKETS / 60) * 60)
}

/**
 * The sparkline query's points as series. A counter's missing bucket is a zero (the poller
 * stores no zero deltas), so its series spans the whole window; a gauge's is a gap, left out.
 */
export function gcpSparks(
	reads: ReadonlyArray<{
		readonly service: GcpInfraServiceId
		readonly points: ReadonlyArray<GcpSparklinePoint>
	}>,
	window: { readonly startTime: string; readonly endTime: string; readonly bucketSeconds: number },
): GcpSparks {
	const step = window.bucketSeconds * 1000
	const first = Math.floor(utcMs(window.startTime) / step) * step
	const buckets = Math.max(1, Math.floor((utcMs(window.endTime) - first) / step) + 1)
	const sparks = new Map<string, Map<string, Array<number>>>()
	for (const { service, points } of reads) {
		const counters = new Set(
			gcpInfraMetrics(service)
				.filter((metric) => metric.kind === "sum")
				.map((metric) => metric.name),
		)
		for (const workload of gcpWorkloadPoints(points)) {
			const id = gcpWorkloadId(workload.keys)
			const series = sparks.get(id) ?? new Map<string, Array<number>>()
			sparks.set(id, series)
			for (const metric of new Set(workload.points.map((point) => point.metric))) {
				const ofMetric = workload.points
					.filter((point) => point.metric === metric)
					.toSorted((a, b) => utcMs(a.bucket) - utcMs(b.bucket))
				if (counters.has(metric)) {
					const values = Array.from({ length: buckets }, () => 0)
					for (const point of ofMetric) {
						const index = Math.round((utcMs(point.bucket) - first) / step)
						if (index >= 0 && index < buckets) values[index] += point.total
					}
					series.set(metric, values)
				} else {
					series.set(
						metric,
						ofMetric.map((point) => point.total / point.samples),
					)
				}
			}
		}
	}
	return sparks
}

// Views -----------------------------------------------------------------------------------------

/** `?view=`, else a link from before the views: `?tab=` named a service. */
export function gcpRequestedView(view: string | undefined, tab: string | undefined): GcpView | undefined {
	const wanted = view ?? (tab === "cloudRun" || tab === "cloudFunctions" ? "services" : tab)
	return GCP_VIEWS.find((candidate) => candidate === wanted)
}

/**
 * The views on the page and the one shown. A view shows while it has rows, and the requested one
 * always, so a link or a narrower time range lands on its empty state. The inventory only while a
 * connection collects: the resources of one that stopped are not listed. `counts` is null while
 * the fleet loads: only the requested view is listed then, so an unrequested page waits on the
 * services skeleton instead of showing the inventory and jumping away from it.
 */
export function gcpViews(
	counts: Readonly<Record<GcpServiceView, number>> | null,
	requested: GcpView | undefined,
	collecting: boolean,
): { readonly views: ReadonlyArray<GcpView>; readonly view: GcpView } {
	const views = GCP_VIEWS.filter((view) =>
		view === requested
			? view !== GCP_RESOURCES_TAB || collecting
			: counts !== null && (view === GCP_RESOURCES_TAB ? collecting : counts[view] > 0),
	)
	const view = views.find((candidate) => candidate === requested) ?? views[0] ?? "services"
	return { views, view }
}

// Rows ------------------------------------------------------------------------------------------

interface GcpRowBase {
	readonly service: GcpInfraServiceId
	readonly keys: ReadonlyArray<string>
	readonly name: string
	readonly project: string | undefined
	readonly region: string | undefined
}

const rowBase = (service: GcpInfraServiceId, keys: ReadonlyArray<string>): GcpRowBase => ({
	service,
	keys,
	name: gcpWorkloadName(service, keys),
	project: gcpWorkloadProject(service, keys) || undefined,
	region: gcpWorkloadRegion(service, keys) || undefined,
})

const workloadsOf = (fleet: ReadonlyArray<GcpFleetRead>, service: GcpInfraServiceId) =>
	gcpWorkloadPoints(fleet.find((entry) => entry.service === service)?.points ?? [])

const spark = (sparks: GcpSparks, keys: ReadonlyArray<string>, metric: string) =>
	sparks.get(gcpWorkloadId(keys))?.get(metric)

/** Volume, problems and their order, for one kind of row. */
export interface RowRules<R, S extends string> {
	/** The band's cells, in its order. */
	readonly scopes: ReadonlyArray<S>
	/** Worst first: a row's health is the first of these it is in. */
	readonly worst: ReadonlyArray<S>
	readonly inScope: (row: R, scope: S) => boolean
	/** Within a health, bigger first. */
	readonly volume: (row: R) => number
}

export const rowHealth = <R, S extends string>(rules: RowRules<R, S>, row: R): S | "ok" =>
	rules.worst.find((scope) => rules.inScope(row, scope)) ?? "ok"

/** Problems first, the worst signal first, then by volume. */
export function sortByAttention<R, S extends string>(
	rules: RowRules<R, S>,
	rows: ReadonlyArray<R>,
): ReadonlyArray<R> {
	const rank = (row: R) => {
		const health = rowHealth(rules, row)
		return health === "ok" ? rules.worst.length : rules.worst.indexOf(health)
	}
	return rows.toSorted((a, b) => rank(a) - rank(b) || rules.volume(b) - rules.volume(a))
}

// Cloud Run services and Cloud Functions -------------------------------------------------------

const RUN = "gcp.cloud_run"
const FUNCTION = "gcp.cloud_functions"

export const GCP_SLOW_P95_SECONDS = 1

/**
 * Mean billed instances that make a service without requests idle. Below it, a deploy's startup
 * check or one request's warm instance would read as idle.
 */
export const GCP_IDLE_BILLED_INSTANCES = 0.5

export interface GcpServiceRow extends GcpRowBase {
	readonly service: "cloudRun" | "cloudFunctions"
	/** Requests, or a 1st gen function's executions. */
	readonly requests: number
	/** 4xx responses; a function reports none. */
	readonly clientErrors: number
	/** 5xx responses, or executions that did not end ok. */
	readonly failed: number
	/** Seconds: request latency, or execution time. */
	readonly latencyP95: number | undefined
	/** Mean active instances. */
	readonly instances: number | undefined
	/** Cloud Run only. */
	readonly cpuP95: number | undefined
	/** Mean billed instances over the window: billable instance time per second; Cloud Run only. */
	readonly billedInstances: number
	readonly volume: ReadonlyArray<number> | undefined
}

export function gcpServiceRows(
	fleet: ReadonlyArray<GcpFleetRead>,
	sparks: GcpSparks,
	windowSeconds: number,
): ReadonlyArray<GcpServiceRow> {
	const run = workloadsOf(fleet, "cloudRun").map(({ keys, points }): GcpServiceRow => {
		const read = gcpMetricReader(points)
		return {
			...rowBase("cloudRun", keys),
			service: "cloudRun",
			requests: read.total(`${RUN}.requests`),
			clientErrors: read.total(`${RUN}.requests`, "4xx"),
			failed: serverErrors(`${RUN}.requests`)(read),
			latencyP95: read.mean(`${RUN}.request.duration`, "0.95"),
			instances: read.mean(`${RUN}.container.instance.count`, "active"),
			cpuP95: read.mean(`${RUN}.container.cpu.utilization`, "0.95"),
			billedInstances:
				windowSeconds > 0 ? read.total(`${RUN}.container.billable_time`) / windowSeconds : 0,
			volume: spark(sparks, keys, `${RUN}.requests`),
		}
	})
	const functions = workloadsOf(fleet, "cloudFunctions").map(({ keys, points }): GcpServiceRow => {
		const read = gcpMetricReader(points)
		return {
			...rowBase("cloudFunctions", keys),
			service: "cloudFunctions",
			requests: read.total(`${FUNCTION}.executions`),
			clientErrors: 0,
			failed: unhealthy(`${FUNCTION}.executions`, "ok")(read),
			latencyP95: read.mean(`${FUNCTION}.execution.duration`, "0.95"),
			instances: read.mean(`${FUNCTION}.instance.count`, "active"),
			cpuP95: undefined,
			billedInstances: 0,
			volume: spark(sparks, keys, `${FUNCTION}.executions`),
		}
	})
	return [...run, ...functions]
}

/** The failed share, or undefined under `GCP_MIN_EVENTS`: too few to rate. */
export const gcpRatedShare = (part: number, whole: number): number | undefined =>
	whole >= GCP_MIN_EVENTS ? part / whole : undefined

export const GCP_SERVICE_SCOPES = ["serving5xx", "slow", "idle"] as const
export type GcpServiceScope = (typeof GCP_SERVICE_SCOPES)[number]

export const GCP_SERVICE_RULES: RowRules<GcpServiceRow, GcpServiceScope> = {
	scopes: GCP_SERVICE_SCOPES,
	worst: GCP_SERVICE_SCOPES,
	inScope: (row, scope) => {
		switch (scope) {
			case "serving5xx":
				return (gcpRatedShare(row.failed, row.requests) ?? 0) >= ERROR_RATE_WARN
			case "slow":
				return (row.latencyP95 ?? 0) >= GCP_SLOW_P95_SECONDS
			case "idle":
				return row.requests === 0 && row.billedInstances >= GCP_IDLE_BILLED_INSTANCES
		}
	},
	volume: (row) => row.requests,
}

// Pub/Sub subscriptions ------------------------------------------------------------------------

const SUBSCRIPTION = "gcp.pubsub.subscription"

/** A backlog this much older than its first message is stuck, not busy. */
export const GCP_STALE_SECONDS = 600

export interface GcpSubscriptionRow extends GcpRowBase {
	readonly delivered: number
	/** Mean unacknowledged messages. */
	readonly backlog: number | undefined
	readonly oldestUnackedSeconds: number | undefined
	/** Push attempts; a pull subscription makes none. */
	readonly pushRequests: number
	readonly pushFailed: number
	readonly deadLettered: number
	readonly deliveredSpark: ReadonlyArray<number> | undefined
	readonly backlogSpark: ReadonlyArray<number> | undefined
}

export function gcpSubscriptionRows(
	fleet: ReadonlyArray<GcpFleetRead>,
	sparks: GcpSparks,
): ReadonlyArray<GcpSubscriptionRow> {
	return workloadsOf(fleet, "pubsub").map(({ keys, points }) => {
		const read = gcpMetricReader(points)
		return {
			...rowBase("pubsub", keys),
			delivered: read.total(`${SUBSCRIPTION}.sent_messages`),
			backlog: read.mean(`${SUBSCRIPTION}.undelivered_messages`),
			oldestUnackedSeconds: read.mean(`${SUBSCRIPTION}.oldest_unacked_message.age`),
			pushRequests: read.total(`${SUBSCRIPTION}.push_requests`),
			pushFailed: unhealthy(`${SUBSCRIPTION}.push_requests`, "ack")(read),
			deadLettered: read.total(`${SUBSCRIPTION}.dead_lettered_messages`),
			deliveredSpark: spark(sparks, keys, `${SUBSCRIPTION}.sent_messages`),
			backlogSpark: spark(sparks, keys, `${SUBSCRIPTION}.undelivered_messages`),
		}
	})
}

/** How much the backlog rose across the window: its last bucket less its first. */
export const gcpBacklogGrowth = (row: GcpSubscriptionRow): number | undefined => {
	const series = row.backlogSpark
	if (series === undefined || series.length < 2) return undefined
	return series[series.length - 1] - series[0]
}

/** Rising by at least 100 messages and half of where it started: a batch consumer's steady backlog is not. */
const backlogGrowing = (row: GcpSubscriptionRow): boolean => {
	const growth = gcpBacklogGrowth(row)
	const start = row.backlogSpark?.[0] ?? 0
	return growth !== undefined && growth >= Math.max(100, start * 0.5)
}

export const GCP_SUBSCRIPTION_SCOPES = ["backlogGrowing", "stale", "deadLettering"] as const
export type GcpSubscriptionScope = (typeof GCP_SUBSCRIPTION_SCOPES)[number]

export const GCP_SUBSCRIPTION_RULES: RowRules<GcpSubscriptionRow, GcpSubscriptionScope> = {
	scopes: GCP_SUBSCRIPTION_SCOPES,
	// Messages leaving for a dead-letter topic are lost to the consumer; an old one only waits.
	worst: ["backlogGrowing", "deadLettering", "stale"],
	inScope: (row, scope) => {
		switch (scope) {
			case "backlogGrowing":
				return backlogGrowing(row)
			case "stale":
				return (row.oldestUnackedSeconds ?? 0) >= GCP_STALE_SECONDS
			case "deadLettering":
				return row.deadLettered > 0
		}
	},
	volume: (row) => row.delivered,
}

// Cloud SQL instances --------------------------------------------------------------------------

const DATABASE = "gcp.cloud_sql"

export const GCP_LIMIT_FRACTION = 0.9
export const GCP_FILLING_FRACTION = 0.8
export const GCP_REPLICA_LAG_SECONDS = 10
/** Transaction IDs used toward wraparound: past half, autovacuum is falling behind. */
export const GCP_WRAPAROUND_FRACTION = 0.5
/** How Cloud Monitoring labels a PostgreSQL connection that holds a transaction open and does nothing. */
export const GCP_IDLE_IN_TRANSACTION = "idle_in_transaction"

/** A read replica, folded into its primary's row. */
export interface GcpReplica {
	readonly name: string
	readonly lagSeconds: number | undefined
}

export interface GcpDatabaseRow extends GcpRowBase {
	/** Its settings from the inventory; undefined until they load, or for an instance it does not list. */
	readonly instance: GcpCloudSqlInstance | undefined
	/** Its engine as a `databaseVersion`: the inventory's, else what its metrics give away. */
	readonly engine: string | undefined
	/** Fractions of the reserved CPU, the memory quota and the disk quota. */
	readonly cpu: number | undefined
	readonly memory: number | undefined
	readonly disk: number | undefined
	readonly connections: number | undefined
	/** PostgreSQL only. */
	readonly idleInTransaction: number | undefined
	/** Query Insights (PostgreSQL with it on): queries run, and their p95 in seconds. */
	readonly queries: number | undefined
	readonly queryP95: number | undefined
	/** MySQL only: queries slower than `long_query_time`. */
	readonly slowQueries: number
	/** PostgreSQL only: the fraction of transaction IDs used toward wraparound. */
	readonly transactionIds: number | undefined
	/** Reported by a read replica only. */
	readonly replicaLagSeconds: number | undefined
	/** The read replicas folded into this row: a primary's. */
	readonly replicas: ReadonlyArray<GcpReplica>
	readonly queriesSpark: ReadonlyArray<number> | undefined
}

/**
 * A Cloud SQL instance's engine from its own metrics, as a `databaseVersion` prefix, for when the
 * inventory has no settings for it. SQL Server reports no engine metrics of its own.
 */
export const gcpSqlEngineOf = (points: ReadonlyArray<{ readonly metric: string }>): string | undefined =>
	points.some((point) => point.metric.startsWith(`${DATABASE}.postgresql.`))
		? "POSTGRES"
		: points.some((point) => point.metric.startsWith(`${DATABASE}.mysql.`))
			? "MYSQL"
			: undefined

/**
 * One row per instance, joined to its inventory settings by `<project>:<instance>`. A read replica
 * whose primary has a row is folded into it; without the inventory, replicas keep rows of their own.
 */
export function gcpDatabaseRows(
	fleet: ReadonlyArray<GcpFleetRead>,
	sparks: GcpSparks,
	instances: ReadonlyArray<GcpCloudSqlInstance> = [],
): ReadonlyArray<GcpDatabaseRow> {
	const byId = new Map(instances.map((instance) => [instance.id, instance]))
	const rows = workloadsOf(fleet, "cloudSql").map(({ keys, points }): GcpDatabaseRow => {
		const read = gcpMetricReader(points)
		const queryP95 = read.mean(`${DATABASE}.query.duration`, "0.95")
		const queries = read.total(`${DATABASE}.queries`)
		return {
			...rowBase("cloudSql", keys),
			instance: byId.get(keys[0]),
			engine: byId.get(keys[0])?.databaseVersion ?? gcpSqlEngineOf(points),
			cpu: read.mean(`${DATABASE}.cpu.utilization`),
			memory: read.mean(`${DATABASE}.memory.utilization`),
			disk: read.mean(`${DATABASE}.disk.utilization`),
			connections: read.mean(`${DATABASE}.connection.count`),
			idleInTransaction: read.mean(`${DATABASE}.postgresql.connection.count`, GCP_IDLE_IN_TRANSACTION),
			// The poller stores no zero deltas: an instance without either reported no insights.
			queries: queries > 0 || queryP95 !== undefined ? queries : undefined,
			queryP95,
			slowQueries: read.total(`${DATABASE}.mysql.slow_queries`),
			transactionIds: read.mean(`${DATABASE}.postgresql.transaction_id.utilization`),
			replicaLagSeconds: read.mean(`${DATABASE}.replication.lag`),
			replicas: [],
			queriesSpark: spark(sparks, keys, `${DATABASE}.queries`),
		}
	})
	const ids = new Set(rows.map((row) => row.keys[0]))
	const primaryOf = (row: GcpDatabaseRow) => {
		const primary = row.instance?.primary ?? null
		return primary !== null && ids.has(primary) ? primary : undefined
	}
	return rows.flatMap((row) => {
		if (primaryOf(row) !== undefined) return []
		const replicas = rows
			.filter((candidate) => primaryOf(candidate) === row.keys[0])
			.map((replica) => ({ name: replica.name, lagSeconds: replica.replicaLagSeconds }))
		return [replicas.length === 0 ? row : { ...row, replicas }]
	})
}

/** Open connections as a share of `max_connections`; undefined while either is unknown. */
export const gcpConnectionShare = (row: GcpDatabaseRow): number | undefined => {
	const max = row.instance?.maxConnections ?? null
	return row.connections === undefined || max === null || max === 0 ? undefined : row.connections / max
}

/** The resource closest to its limit: connections run out first. */
export const gcpDatabasePeak = (row: GcpDatabaseRow): number =>
	Math.max(0, row.cpu ?? 0, row.memory ?? 0, row.disk ?? 0, gcpConnectionShare(row) ?? 0)

/** The most a row's replica, or the row itself when it is an unfolded replica, lags. */
const worstLag = (row: GcpDatabaseRow): number =>
	Math.max(row.replicaLagSeconds ?? 0, ...row.replicas.map((replica) => replica.lagSeconds ?? 0))

/** Query Insights is off on a PostgreSQL instance: its query columns are dashes. */
export const gcpQueryInsightsOff = (row: GcpDatabaseRow): boolean =>
	row.instance !== undefined &&
	row.instance.databaseVersion?.startsWith("POSTGRES") === true &&
	!row.instance.queryInsightsEnabled

/** The band's cells first; the last two only rate a row. */
export const GCP_DATABASE_SCOPES = ["atLimit", "slow", "wraparound"] as const
export type GcpDatabaseScope = (typeof GCP_DATABASE_SCOPES)[number] | "fillingUp" | "replicaLag"

export const GCP_DATABASE_RULES: RowRules<GcpDatabaseRow, GcpDatabaseScope> = {
	scopes: GCP_DATABASE_SCOPES,
	worst: ["atLimit", "wraparound", "slow", "fillingUp", "replicaLag"],
	inScope: (row, scope) => {
		switch (scope) {
			case "atLimit":
				return gcpDatabasePeak(row) >= GCP_LIMIT_FRACTION
			case "fillingUp":
				return (
					gcpDatabasePeak(row) >= GCP_FILLING_FRACTION && gcpDatabasePeak(row) < GCP_LIMIT_FRACTION
				)
			case "slow":
				return (row.queryP95 ?? 0) >= GCP_SLOW_P95_SECONDS
			case "wraparound":
				return (row.transactionIds ?? 0) >= GCP_WRAPAROUND_FRACTION
			case "replicaLag":
				return worstLag(row) >= GCP_REPLICA_LAG_SECONDS
		}
	},
	// Closest to a limit first.
	volume: gcpDatabasePeak,
}

// GKE containers, VMs, URL maps ----------------------------------------------------------------

export type GcpGenericView = "gke" | "computeEngine" | "loadBalancing"

export interface GcpWorkloadRow extends GcpRowBase {
	readonly workload: GcpWorkload
}

export const gcpWorkloadRows = (
	fleet: ReadonlyArray<GcpFleetRead>,
	service: GcpGenericView,
): ReadonlyArray<GcpWorkloadRow> =>
	workloadsOf(fleet, service).map(({ keys, points }) => ({
		...rowBase(service, keys),
		workload: gcpWorkload(service, keys, points),
	}))

export const GCP_WORKLOAD_SCOPES = ["atLimit", "hot", "erroring"] as const
export type GcpWorkloadScope = (typeof GCP_WORKLOAD_SCOPES)[number]

export const GCP_WORKLOAD_RULES: RowRules<GcpWorkloadRow, GcpWorkloadScope> = {
	scopes: GCP_WORKLOAD_SCOPES,
	worst: ["atLimit", "erroring", "hot"],
	inScope: (row, scope) => {
		switch (scope) {
			case "atLimit":
				return row.workload.saturation === "crit"
			case "hot":
				return row.workload.saturation === "warn"
			case "erroring":
				return row.workload.errors === "crit"
		}
	},
	// The first column is the service's volume: CPU, or requests.
	volume: (row) => row.workload.values[0] ?? 0,
}

// The page's rows ------------------------------------------------------------------------------

export interface GcpListRows {
	readonly services: ReadonlyArray<GcpServiceRow>
	readonly pubsub: ReadonlyArray<GcpSubscriptionRow>
	readonly cloudSql: ReadonlyArray<GcpDatabaseRow>
	readonly gke: ReadonlyArray<GcpWorkloadRow>
	readonly computeEngine: ReadonlyArray<GcpWorkloadRow>
	readonly loadBalancing: ReadonlyArray<GcpWorkloadRow>
}

/**
 * `windowSeconds`: the range the fleet was read over. `instances`: the Cloud SQL inventory, read
 * only while that view shows.
 */
export const gcpListRows = (
	fleet: ReadonlyArray<GcpFleetRead>,
	sparks: GcpSparks,
	windowSeconds: number,
	instances?: ReadonlyArray<GcpCloudSqlInstance>,
): GcpListRows => ({
	services: gcpServiceRows(fleet, sparks, windowSeconds),
	pubsub: gcpSubscriptionRows(fleet, sparks),
	cloudSql: gcpDatabaseRows(fleet, sparks, instances),
	gke: gcpWorkloadRows(fleet, "gke"),
	computeEngine: gcpWorkloadRows(fleet, "computeEngine"),
	loadBalancing: gcpWorkloadRows(fleet, "loadBalancing"),
})

const VIEW_ROW_KEYS = ["services", "pubsub", "cloudSql", "gke", "computeEngine", "loadBalancing"] as const

/** Only the rows of one project and region; an absent filter keeps every row. */
export function gcpRowsIn(
	rows: GcpListRows,
	place: { readonly project?: string | undefined; readonly region?: string | undefined },
): GcpListRows {
	const keep = (row: GcpRowBase) =>
		(place.project === undefined || row.project === place.project) &&
		(place.region === undefined || row.region === place.region)
	return {
		services: rows.services.filter(keep),
		pubsub: rows.pubsub.filter(keep),
		cloudSql: rows.cloudSql.filter(keep),
		gke: rows.gke.filter(keep),
		computeEngine: rows.computeEngine.filter(keep),
		loadBalancing: rows.loadBalancing.filter(keep),
	}
}

export const gcpViewCounts = (rows: GcpListRows): Record<GcpServiceView, number> => ({
	services: rows.services.length,
	pubsub: rows.pubsub.length,
	cloudSql: rows.cloudSql.length,
	gke: rows.gke.length,
	computeEngine: rows.computeEngine.length,
	loadBalancing: rows.loadBalancing.length,
})

/** Whether the query of a service of the view failed: its rows are unknown, not absent. */
export const gcpViewFailed = (fleet: ReadonlyArray<GcpFleetRead>, view: GcpServiceView): boolean =>
	fleet.some(
		(entry) => entry.failed && GCP_VIEW_SERVICES[view].some((service) => service === entry.service),
	)

/** A view's rows as what every row has. */
const listed = (rows: GcpListRows, view: GcpServiceView): ReadonlyArray<GcpRowBase> => rows[view]

const NO_ROWS: GcpListRows = {
	services: [],
	pubsub: [],
	cloudSql: [],
	gke: [],
	computeEngine: [],
	loadBalancing: [],
}

/**
 * What the page shows of the rows: the projects, the project and region it is scoped to (a
 * project it does not know is no scope), the rows in that scope, and the views. `allRows` is null
 * while the fleet loads.
 */
export function gcpListScope(
	allRows: GcpListRows | null,
	state: { readonly view?: GcpView; readonly project?: string; readonly region?: string },
	collecting: boolean,
) {
	const projects = gcpProjects(allRows ?? NO_ROWS)
	// An empty param in a hand-edited address is no filter.
	const region = state.region || undefined
	const project = projects.find((candidate) => candidate === state.project)
	const inRegion = gcpRowsIn(allRows ?? NO_ROWS, { region })
	const rows = gcpRowsIn(inRegion, { project })
	const counts = allRows === null ? null : gcpViewCounts(rows)
	return { projects, project, region, inRegion, rows, counts, ...gcpViews(counts, state.view, collecting) }
}

/** The services whose sparklines a view draws: see `gcpInfraSparklinesSQL`. */
export const gcpSparklineServices = (view: GcpView): ReadonlyArray<GcpInfraServiceId> =>
	view === "services" || view === "pubsub" || view === "cloudSql" ? GCP_VIEW_SERVICES[view] : []

// Projects -------------------------------------------------------------------------------------

/** Every project with a workload, the biggest first. */
export function gcpProjects(rows: GcpListRows): ReadonlyArray<string> {
	const counts = new Map<string, number>()
	for (const key of VIEW_ROW_KEYS) {
		for (const row of listed(rows, key)) {
			if (row.project !== undefined) counts.set(row.project, (counts.get(row.project) ?? 0) + 1)
		}
	}
	return [...counts].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([project]) => project)
}

/** Each project's share of a view: requests, delivered messages, or else its number of rows. */
export function gcpProjectShares(rows: GcpListRows, view: GcpServiceView): ReadonlyMap<string, number> {
	const volume: ReadonlyArray<{ readonly project: string | undefined; readonly volume: number }> =
		view === "services"
			? rows.services.map((row) => ({ project: row.project, volume: row.requests }))
			: view === "pubsub"
				? rows.pubsub.map((row) => ({ project: row.project, volume: row.delivered }))
				: listed(rows, view).map((row) => ({ project: row.project, volume: 1 }))
	const totals = new Map<string, number>()
	for (const row of volume) {
		if (row.project !== undefined) totals.set(row.project, (totals.get(row.project) ?? 0) + row.volume)
	}
	const sum = [...totals.values()].reduce((a, b) => a + b, 0)
	return new Map([...totals].map(([project, n]) => [project, sum > 0 ? n / sum : 0]))
}

/** What one row of a view is, singular and plural. */
export const GCP_VIEW_NOUN = {
	services: ["service", "services"],
	pubsub: ["subscription", "subscriptions"],
	cloudSql: ["database", "databases"],
	gke: ["container", "containers"],
	computeEngine: ["VM", "VMs"],
	loadBalancing: ["URL map", "URL maps"],
} as const satisfies Record<GcpServiceView, readonly [string, string]>

/** "9 services · 2 databases": the current view first, then every other view with rows. */
export function gcpProjectCounts(rows: GcpListRows, project: string, view: GcpView): string {
	const views = VIEW_ROW_KEYS.toSorted((a, b) => Number(b === view) - Number(a === view))
	return views
		.flatMap((key) => {
			const count = listed(rows, key).filter((row) => row.project === project).length
			const [one, many] = GCP_VIEW_NOUN[key]
			return count > 0 || key === view ? [`${count} ${count === 1 ? one : many}`] : []
		})
		.join(" · ")
}

export interface GcpProjectHealth {
	readonly tone: Tone
	readonly message: string
}

/**
 * What the connection of a project says about its metrics. Only a project connected on its own
 * has one: the projects under a folder or organization share theirs, which the notice reports.
 */
export function gcpProjectHealth(
	connectors: ReadonlyArray<Parameters<typeof gcpMetricsState>[0] & Pick<V2GcpConnector, "scope_id">>,
	nowMs: number,
): ReadonlyMap<string, GcpProjectHealth> {
	const health = new Map<string, GcpProjectHealth>()
	for (const connector of connectors) {
		if (connector.scope_type !== "project") continue
		const state = gcpMetricsState(connector, nowMs)
		if (state.kind === "off") continue
		const status = GCP_METRICS_STATUS[state.kind]
		health.set(connector.scope_id, {
			tone: status.tone,
			message: `metrics ${status.label.toLowerCase()}`,
		})
	}
	return health
}
