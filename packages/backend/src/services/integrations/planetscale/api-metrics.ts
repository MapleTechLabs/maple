/**
 * Branch metrics read from PlanetScale's metrics API (`GET .../branches/{branch}/metrics`, OAuth
 * `read_branches`) and re-expressed as the gauge rows Prometheus scraping produces, so the service
 * map, the infra pages and the alert templates read them unchanged.
 *
 * - A metric the API serves under its Prometheus name keeps it (pod CPU and memory).
 * - Replica lag is split by product into the names the registry already knows.
 * - Storage arrives as used bytes plus used %; capacity and free space are derived per timestamp,
 *   because the storage queries pair `planetscale_volume_capacity_bytes` with
 *   `planetscale_volume_available_bytes`.
 * - Connections become `planetscale_api_connections`: on Postgres the API counts PgBouncer client
 *   connections, a different layer than Prometheus' edge connections, so it gets its own name.
 *
 * A connection is either scraped (service token) or polled, never both, so a shared name never
 * holds two sources for one branch.
 */
import { Schema } from "effect"
import {
	fmtMetricTs,
	type MetricAttrs,
	type MetricGaugeRow,
} from "@maple/backend/services/warehouse/metric-rows"

/** Metrics requested per product kind; Vitess branches serve no pod or volume metrics. */
export const API_METRICS_BY_KIND = {
	postgresql: [
		"planetscale_pods_cpu_util_percentages",
		"planetscale_pods_mem_util_percentages",
		"planetscale_volume_usage_percentages",
		"planetscale_storage_usage_bytes",
		"planetscale_pgbouncer_current_connections",
		"planetscale_wal_size_bytes",
		"planetscale_replica_lag_seconds",
	],
	mysql: [
		"connections",
		"vtgate_cpu_avg_by_az",
		"vtgate_memory_avg_by_az",
		"planetscale_replica_lag_seconds",
	],
} as const

export const apiMetricsFor = (kind: string): ReadonlyArray<string> =>
	kind === "postgresql" ? API_METRICS_BY_KIND.postgresql : API_METRICS_BY_KIND.mysql

const RENAMES = {
	postgresql: new Map([
		["planetscale_pgbouncer_current_connections", "planetscale_api_connections"],
		["planetscale_replica_lag_seconds", "planetscale_postgres_replica_lag_seconds"],
		["planetscale_wal_size_bytes", "planetscale_postgres_wal_size_bytes"],
	]),
	mysql: new Map([
		["connections", "planetscale_api_connections"],
		["vtgate_cpu_avg_by_az", "planetscale_vtgate_cpu_util_percentages"],
		["vtgate_memory_avg_by_az", "planetscale_vtgate_mem_util_percentages"],
		["planetscale_replica_lag_seconds", "planetscale_mysql_replica_lag_seconds"],
	]),
}

/** Consumed only to derive capacity and free space; neither is emitted as itself. */
const USED_PERCENT = "planetscale_volume_usage_percentages"
const USED_BYTES = "planetscale_storage_usage_bytes"

const UNITS = new Map([
	["planetscale_pods_cpu_util_percentages", "%"],
	["planetscale_pods_mem_util_percentages", "%"],
	["planetscale_vtgate_cpu_util_percentages", "%"],
	["planetscale_vtgate_mem_util_percentages", "%"],
	["planetscale_postgres_replica_lag_seconds", "s"],
	["planetscale_mysql_replica_lag_seconds", "s"],
	["planetscale_postgres_wal_size_bytes", "By"],
	["planetscale_volume_capacity_bytes", "By"],
	["planetscale_volume_available_bytes", "By"],
	["planetscale_api_connections", "{connection}"],
])

/** The fields of a `MetricSeries` response this module reads; points are `[unix seconds, value]`. */
export const ApiMetricSeries = Schema.Struct({
	series: Schema.Array(
		Schema.Struct({
			metric: Schema.String,
			label: Schema.optionalKey(Schema.NullOr(Schema.String)),
			points: Schema.Array(Schema.Tuple([Schema.Number, Schema.NullOr(Schema.Number)])),
		}),
	),
})
export type ApiMetricSeries = Schema.Schema.Type<typeof ApiMetricSeries>

export interface ApiMetricBranch {
	readonly organization: string
	readonly database: string
	readonly kind: string
	readonly branch: string
	readonly branchId: string
	/** The `service.name` Prometheus scraping uses for the organization, `PlanetScale (<org>)`. */
	readonly serviceName: string
}

const row = (
	branch: ApiMetricBranch,
	name: string,
	timestampSeconds: number,
	value: number,
	extra: MetricAttrs,
): MetricGaugeRow => {
	const ts = fmtMetricTs(timestampSeconds * 1000)
	return {
		timestamp: ts,
		start_timestamp: ts,
		metric_name: name,
		metric_description: "",
		metric_unit: UNITS.get(name) ?? "",
		metric_attributes: {
			planetscale_organization_name: branch.organization,
			planetscale_database_name: branch.database,
			planetscale_branch_name: branch.branch,
			planetscale_database_branch_id: branch.branchId,
			planetscale_source: "api",
			...extra,
		},
		service_name: branch.serviceName,
		resource_schema_url: "",
		resource_attributes: { "service.name": branch.serviceName },
		scope_schema_url: "",
		scope_name: "maple-planetscale-api",
		scope_version: "",
		scope_attributes: {},
		value,
		flags: 0,
		exemplars_trace_id: [],
		exemplars_span_id: [],
		exemplars_timestamp: [],
		exemplars_value: [],
		exemplars_filtered_attributes: [],
	}
}

/**
 * One branch's API response → gauge rows for the points in `window` (unix seconds, `untilSeconds`
 * excluded, so consecutive windows neither overlap nor leave a gap). Points without a finite value
 * are dropped.
 */
export const apiMetricRows = (
	branch: ApiMetricBranch,
	response: ApiMetricSeries,
	window: { readonly fromSeconds: number; readonly untilSeconds: number },
): Array<MetricGaugeRow> => {
	const renames = branch.kind === "postgresql" ? RENAMES.postgresql : RENAMES.mysql
	const rows: Array<MetricGaugeRow> = []
	const usedPercent = new Map<number, number>()
	const usedBytes = new Map<number, number>()
	for (const series of response.series) {
		// Several series of one metric (replica lag per replica, vtgate per zone) differ only by label.
		const extra: MetricAttrs = series.label != null ? { planetscale_series: series.label } : {}
		for (const [timestamp, value] of series.points) {
			if (value === null || !Number.isFinite(value)) continue
			if (timestamp < window.fromSeconds || timestamp >= window.untilSeconds) continue
			if (series.metric === USED_PERCENT) usedPercent.set(timestamp, value)
			else if (series.metric === USED_BYTES) usedBytes.set(timestamp, value)
			else rows.push(row(branch, renames.get(series.metric) ?? series.metric, timestamp, value, extra))
		}
	}
	for (const [timestamp, percent] of usedPercent) {
		const used = usedBytes.get(timestamp)
		if (used === undefined || percent <= 0) continue
		const capacity = used / (percent / 100)
		rows.push(row(branch, "planetscale_volume_capacity_bytes", timestamp, capacity, {}))
		rows.push(
			row(branch, "planetscale_volume_available_bytes", timestamp, Math.max(capacity - used, 0), {}),
		)
	}
	return rows
}
