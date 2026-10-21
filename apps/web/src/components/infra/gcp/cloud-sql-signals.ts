// A Cloud SQL instance in words and figures: its settings from the inventory, Query Insights
// statements matched to the traces' query shapes, when the app-vs-database callout shows, and the
// rail's health readings. Pure.

import type { GcpCloudSqlTopQueriesResponse } from "@maple/domain/http"
import { formatBytes, formatLatency, formatPercent } from "@maple/ui/lib/format"

import { gcpBuckets, gcpWindowPoints, type GcpBucketPoint } from "./charts"
import type { GcpCloudSqlInstance } from "./inventory"
import {
	GCP_IDLE_IN_TRANSACTION,
	GCP_LIMIT_FRACTION,
	GCP_WRAPAROUND_FRACTION,
	gcpSqlEngineOf,
	type GcpReplica,
} from "./list-model"
import { gcpMetricReader } from "./tabs"
import { gcpRailFacts, type GcpRailFact } from "./workload-signals"

const DATABASE = "gcp.cloud_sql"

const ENGINES: ReadonlyArray<readonly [prefix: string, name: string]> = [
	["POSTGRES", "Postgres"],
	["MYSQL", "MySQL"],
	["SQLSERVER", "SQL Server"],
]

/** `POSTGRES_15` as "Postgres 15", `MYSQL_8_0` as "MySQL 8.0", `SQLSERVER_2022_STANDARD` as "SQL Server 2022 standard". */
export function gcpSqlEngine(databaseVersion: string | null): string | undefined {
	if (databaseVersion === null) return undefined
	const [prefix, ...version] = databaseVersion.split("_")
	const name = ENGINES.find(([engine]) => engine === prefix)?.[1]
	if (name === undefined) return databaseVersion
	if (prefix !== "SQLSERVER") return [name, version.join(".")].filter(Boolean).join(" ")
	const [year, ...edition] = version
	return [name, year, edition.join(" ").toLowerCase()].filter(Boolean).join(" ")
}

const gigabytes = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 })

/** "4 vCPU, 16 GB", "shared core" for a shared-core tier, else the tier's name. */
export function gcpSqlSize(instance: GcpCloudSqlInstance): string | undefined {
	if (instance.memoryGb === null) return instance.tier ?? undefined
	return instance.cpus === null
		? "shared core"
		: `${instance.cpus} vCPU, ${gigabytes(instance.memoryGb)} GB`
}

/** "Enterprise", "Enterprise Plus". */
export const gcpSqlEdition = (edition: string | null): string | undefined =>
	edition === null
		? undefined
		: edition
				.split("_")
				.map((word) => word.charAt(0) + word.slice(1).toLowerCase())
				.join(" ")

/** The console page where Query Insights is turned on for an instance. */
export const gcpQueryInsightsConsoleUrl = (project: string, instance: string): string =>
	`https://console.cloud.google.com/sql/instances/${encodeURIComponent(instance)}/insights?project=${encodeURIComponent(project)}`

// Statements -------------------------------------------------------------------------------------

/** A Query Insights statement over the window, as the top queries table shows it. */
export interface GcpStatement {
	readonly queryHash: string
	/** Normalized by Query Insights: literals are `$1`, `$2`, ... */
	readonly querystring: string
	readonly calls: number
	/** Null without calls in the window. */
	readonly p50LatencyMillis: number | null
	readonly p95LatencyMillis: number | null
	readonly totalExecutionMillis: number
	/** Of the instance's execution time in the window, 0-1. */
	readonly executionShare: number
	readonly rows: number
	/** Of the statement's execution time, 0-1. */
	readonly lockShare: number
	readonly ioShare: number
}

/**
 * The stored statements as the table reads them, each one's time a share of the instance's in
 * the window (`points`, its metrics): every statement's, and never less than the rows' own.
 */
export function gcpStatements(
	rows: GcpCloudSqlTopQueriesResponse["data"],
	points: ReadonlyArray<GcpBucketPoint>,
): ReadonlyArray<GcpStatement> {
	const whole = Math.max(
		gcpMetricReader(gcpWindowPoints(points)).total(`${DATABASE}.query.execution.time`),
		rows.reduce((sum, row) => sum + row.executionSeconds, 0),
	)
	const share = (part: number, of: number) => (of > 0 ? part / of : 0)
	return rows.map((row) => ({
		queryHash: row.queryHash,
		querystring: row.statement,
		calls: row.calls,
		p50LatencyMillis: row.calls > 0 ? row.p50Seconds * 1000 : null,
		p95LatencyMillis: row.calls > 0 ? row.p95Seconds * 1000 : null,
		totalExecutionMillis: row.executionSeconds * 1000,
		executionShare: share(row.executionSeconds, whole),
		rows: row.rowCount,
		lockShare: share(row.lockSeconds, row.executionSeconds),
		ioShare: share(row.ioSeconds, row.executionSeconds),
	}))
}

/** Why Query Insights has no statements for an instance, when its settings say so. */
export function gcpQueryInsightsUnavailable(instance: GcpCloudSqlInstance | undefined): string | null {
	if (instance === undefined) return null
	if (instance.databaseVersion !== null && !instance.databaseVersion.startsWith("POSTGRES")) {
		return `Maple reads Query Insights for PostgreSQL instances only. ${instance.name} runs ${gcpSqlEngine(instance.databaseVersion)}.`
	}
	return instance.queryInsightsEnabled
		? null
		: `Query Insights is off for this instance. Turn it on in ${instance.name}'s Query Insights settings in the Google Cloud console; statements appear from then on.`
}

/**
 * A statement as both ends can agree on it: Query Insights writes literals as `$1`, a span may
 * carry them or a driver's `?`. Lower case, every literal and placeholder `?`, an `IN` list of any
 * length one `?`, whitespace collapsed and dropped around punctuation, no trailing semicolon.
 */
export const gcpNormalizeStatement = (statement: string): string =>
	statement
		.toLowerCase()
		.replace(/'(?:[^']|'')*'/g, "?")
		.replace(/\$\d+/g, "?")
		.replace(/\b\d+(?:\.\d+)?\b/g, "?")
		.replace(/\s+/g, " ")
		.replace(/\s*([(),=])\s*/g, "$1")
		.replace(/\?(?:,\?)+/g, "?")
		.replace(/[\s;]+$/, "")
		.trim()

/** A query pattern the traces recorded against the instance's databases: see `serviceDbTopQueriesSQL`. */
export interface GcpTracedQuery {
	/** The shape's fingerprint (`DB_QUERY_KEY_SQL`), which its spans are found by. */
	readonly queryKey: string
	readonly sampleStatement: string
	readonly sampleService: string
	readonly serviceCount: number
	readonly estimatedQueryCount: number
	readonly p95DurationMs: number
}

/** A Query Insights statement as the traces saw it. */
export interface GcpTracedStatement {
	/** The services seen calling it, the busiest first. */
	readonly services: ReadonlyArray<string>
	/** How many services called it: at least `services.length`. */
	readonly serviceCount: number
	/** The client spans' p95, where it is called most. */
	readonly appP95Ms: number
	/** The traced shapes it matched, busiest first: its spans are theirs. */
	readonly queryKeys: ReadonlyArray<string>
}

/** The traced side of each statement, by `queryHash`; a statement the traces never recorded has none. */
export function gcpMatchStatements(
	rows: ReadonlyArray<Pick<GcpStatement, "queryHash" | "querystring">>,
	tracedQueries: ReadonlyArray<GcpTracedQuery>,
): ReadonlyMap<string, GcpTracedStatement> {
	const byStatement = new Map<string, Array<GcpTracedQuery>>()
	for (const query of tracedQueries) {
		if (query.sampleStatement === "") continue
		const key = gcpNormalizeStatement(query.sampleStatement)
		byStatement.set(key, [...(byStatement.get(key) ?? []), query])
	}
	const matched = new Map<string, GcpTracedStatement>()
	for (const row of rows) {
		const found = byStatement
			.get(gcpNormalizeStatement(row.querystring))
			?.toSorted((a, b) => b.estimatedQueryCount - a.estimatedQueryCount)
		if (found === undefined) continue
		const services = [...new Set(found.map((query) => query.sampleService))]
		matched.set(row.queryHash, {
			services,
			serviceCount: Math.max(services.length, ...found.map((query) => query.serviceCount)),
			appP95Ms: found[0].p95DurationMs,
			queryKeys: [...new Set(found.map((query) => query.queryKey))],
		})
	}
	return matched
}

const MIN_PREFIX = 16
const MAX_PREFIX = 200

/**
 * What a span's `db.query.text` of the statement contains for sure: its first line up to the first
 * placeholder, since a span may carry the literals instead, capped to keep a link short. Null when
 * that is too short to tell statements apart.
 */
export const gcpStatementTextPrefix = (statement: string): string | null => {
	const prefix = (statement.split(/\$\d/)[0] ?? "").split("\n")[0]?.trim().slice(0, MAX_PREFIX) ?? ""
	return prefix.length >= MIN_PREFIX ? prefix : null
}

/** The app side this many times slower than the database, and by at least `APP_WAIT_MIN_MS`. */
const APP_WAIT_RATIO = 5
const APP_WAIT_MIN_MS = 200

/** A statement the app waits on far longer than the database runs it. */
export interface GcpAppWait {
	readonly service: string
	readonly statement: string
	readonly appP95Ms: number
	readonly dbP95Ms: number
}

/** The statement whose app-side p95 is the most times its database-side p95, when one is worth a callout. */
export function gcpAppWait(
	rows: ReadonlyArray<Pick<GcpStatement, "queryHash" | "querystring" | "p95LatencyMillis">>,
	traced: ReadonlyMap<string, GcpTracedStatement>,
): GcpAppWait | null {
	const waits = rows.flatMap((row): ReadonlyArray<GcpAppWait> => {
		const app = traced.get(row.queryHash)
		const db = row.p95LatencyMillis
		if (app === undefined || db === null) return []
		const appP95Ms = app.appP95Ms
		return appP95Ms >= APP_WAIT_RATIO * db && appP95Ms - db >= APP_WAIT_MIN_MS
			? [{ service: app.services[0], statement: row.querystring, appP95Ms, dbP95Ms: db }]
			: []
	})
	return waits.toSorted((a, b) => b.appP95Ms / b.dbP95Ms - a.appP95Ms / a.dbP95Ms)[0] ?? null
}

// Connections ------------------------------------------------------------------------------------

/** The window's busiest moment for connections. */
export interface GcpConnectionPeak {
	readonly open: number
	/** Of those, PostgreSQL connections holding a transaction open and doing nothing. */
	readonly idleInTransaction: number | undefined
	/** `max_connections`; null when the inventory does not know it. */
	readonly max: number | null
}

/** The bucket with the most open connections, and how many of them sat idle in a transaction. */
export function gcpConnectionPeak(
	points: ReadonlyArray<GcpBucketPoint>,
	bucketSeconds: number,
	max: number | null,
): GcpConnectionPeak | undefined {
	let peak: GcpConnectionPeak | undefined
	for (const { points: bucketPoints } of gcpBuckets(points, bucketSeconds)) {
		const read = gcpMetricReader(bucketPoints)
		const open = read.mean(`${DATABASE}.connection.count`)
		if (open === undefined || (peak !== undefined && open <= peak.open)) continue
		peak = {
			open,
			idleInTransaction: read.mean(`${DATABASE}.postgresql.connection.count`, GCP_IDLE_IN_TRANSACTION),
			max,
		}
	}
	return peak
}

/** The pool ran out: open connections reached 90% of `max_connections`. */
export const gcpPoolFull = (peak: GcpConnectionPeak | undefined): boolean =>
	peak !== undefined && peak.max !== null && peak.open >= GCP_LIMIT_FRACTION * peak.max

// The rail --------------------------------------------------------------------------------------

/**
 * How healthy PostgreSQL is underneath: deadlocks, transaction IDs used toward wraparound, the
 * share of blocks read from the buffer cache, and what spilled to temporary files. A reading the
 * instance never reported is left out; MySQL reports none of them.
 */
export function gcpCloudSqlHealth(points: ReadonlyArray<GcpBucketPoint>): ReadonlyArray<GcpRailFact> {
	const read = gcpMetricReader(gcpWindowPoints(points))
	const reported = (metric: string) => points.some((point) => point.metric === metric)
	const cached = read.total(`${DATABASE}.postgresql.block_reads`, "buffer_cache")
	const blocks = read.total(`${DATABASE}.postgresql.block_reads`)
	const transactionIds = read.mean(`${DATABASE}.postgresql.transaction_id.utilization`)
	const postgres = transactionIds !== undefined || blocks > 0
	return [
		// A counter stores no zero deltas: on PostgreSQL, none counted is none.
		...(postgres || reported(`${DATABASE}.postgresql.deadlocks`)
			? [{ label: "deadlocks", value: read.total(`${DATABASE}.postgresql.deadlocks`).toLocaleString() }]
			: []),
		...(transactionIds === undefined
			? []
			: [
					{
						label: "transaction IDs",
						value: `${formatPercent(transactionIds)} used`,
						// Wraparound is the list's risk from half used on.
						tone:
							transactionIds >= 0.8
								? "crit"
								: transactionIds >= GCP_WRAPAROUND_FRACTION
									? "warn"
									: "ok",
					} as const,
				]),
		// A tenth of a point matters near 100%: 99.2% and 99.9% are different caches.
		...(blocks > 0
			? [
					{
						label: "cache hit",
						value: `${((cached / blocks) * 100).toFixed(1)}%`,
						// Higher is better: most reads should come from memory.
						tone: cached / blocks >= 0.99 ? "ok" : cached / blocks >= 0.95 ? "warn" : "crit",
					} as const,
				]
			: []),
		...(postgres
			? [{ label: "temp spill", value: formatBytes(read.total(`${DATABASE}.postgresql.temp_file.io`)) }]
			: []),
	]
}

/** What the inventory and the instance's databases say about it, before its readings. */
function cloudSqlFacts(
	instance: GcpCloudSqlInstance | undefined,
	databaseVersion: string | undefined,
	databases: ReadonlyArray<string> | undefined,
	replicas: ReadonlyArray<GcpReplica>,
): ReadonlyArray<GcpRailFact> {
	const engine = gcpSqlEngine(databaseVersion ?? null)
	const edition = instance === undefined ? undefined : gcpSqlEdition(instance.edition)
	return [
		...(engine === undefined
			? []
			: [{ label: "engine", value: edition === undefined ? engine : `${engine} · ${edition}` }]),
		...(databases === undefined || databases.length === 0
			? []
			: [{ label: "databases", value: databases.join(" · ") }]),
		// The name and its lag on lines of their own: a replica's name is long enough to wrap mid-word.
		...replicas.flatMap((replica) => [
			{ label: "read replica", value: replica.name },
			...(replica.lagSeconds === undefined
				? []
				: [{ label: "replica lag", value: formatLatency(replica.lagSeconds * 1000) }]),
		]),
	]
}

/**
 * Everything a Cloud SQL instance's page derives from its reads: each statement's traced side,
 * the callout's statement and connections, the rail's facts and health, and the service the
 * busiest statement is called from.
 */
export function gcpCloudSqlView(input: {
	readonly instance: GcpCloudSqlInstance | undefined
	/** Query Insights' statements, by total time; none while they load or can't be read. */
	readonly statements: ReadonlyArray<GcpStatement>
	readonly tracedQueries: ReadonlyArray<GcpTracedQuery>
	readonly databases: ReadonlyArray<string> | undefined
	readonly replicas: ReadonlyArray<GcpReplica>
	readonly points: ReadonlyArray<GcpBucketPoint>
	readonly bucketSeconds: number
}) {
	const { instance, statements, points, bucketSeconds } = input
	const traced = gcpMatchStatements(statements, input.tracedQueries)
	return {
		traced,
		wait: gcpAppWait(statements, traced),
		peak: gcpConnectionPeak(points, bucketSeconds, instance?.maxConnections ?? null),
		facts: [
			...cloudSqlFacts(
				instance,
				instance?.databaseVersion ?? gcpSqlEngineOf(points),
				input.databases,
				input.replicas,
			),
			...gcpRailFacts("cloudSql", points, bucketSeconds),
		],
		health: gcpCloudSqlHealth(points),
		focusService: statements.flatMap((row) => traced.get(row.queryHash)?.services ?? [])[0],
	}
}
