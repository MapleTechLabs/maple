// /infra/supabase reads, keyed by the `supabase_project_ref` attribute. Gauges are in metrics_gauge;
// counters in metrics_sum are differenced reset-aware (`metricDeltaExpr`), delta-temporality rows as-is.

import type { DateTime } from "effect"
import { finiteOrZero } from "@maple/query-engine/ch/format"
import { metricDeltaExpr } from "@maple/query-engine/ch"
import * as CH from "@maple-dev/effect-orm/expr"
import { from, fromQuery, param, type ColumnAccessor } from "@maple-dev/effect-orm/clickhouse"
import { MetricsGauge, MetricsSum, orgIdParam, utcSecondsParam } from "@maple/query-engine/ch/tables"

export const SUPABASE_PROJECT_REF_ATTRIBUTE = "supabase_project_ref"

const SUPABASE_MEMORY_TOTAL = "node_memory_MemTotal_bytes"
const SUPABASE_MEMORY_AVAILABLE = "node_memory_MemAvailable_bytes"
const SUPABASE_FS_SIZE = "node_filesystem_size_bytes"
const SUPABASE_FS_AVAILABLE = "node_filesystem_avail_bytes"
const SUPABASE_DB_SIZE = "pg_database_size_bytes"
const SUPABASE_BACKENDS = "pg_stat_database_num_backends"
const SUPABASE_POOLER_CLIENTS = "pgbouncer_used_clients"
const SUPABASE_AUTH_USERS = "auth_users_user_count"
const SUPABASE_POSTGREST_POOL_MAX = "pgrst_db_pool_max"
const SUPABASE_POSTGREST_POOL_AVAILABLE = "pgrst_db_pool_available"
const SUPABASE_POSTGREST_POOL_WAITING = "pgrst_db_pool_waiting"

const SUPABASE_CPU_SECONDS = "node_cpu_seconds_total"
const SUPABASE_XACT_COMMIT = "pg_stat_database_xact_commit_total"
const SUPABASE_XACT_ROLLBACK = "pg_stat_database_xact_rollback_total"
const SUPABASE_BLKS_HIT = "pg_stat_database_blks_hit_total"
const SUPABASE_BLKS_READ = "pg_stat_database_blks_read_total"
const SUPABASE_NETWORK_RX = "node_network_receive_bytes_total"
const SUPABASE_NETWORK_TX = "node_network_transmit_bytes_total"
const SUPABASE_DISK_READ = "node_disk_read_bytes_total"
const SUPABASE_DISK_WRITTEN = "node_disk_written_bytes_total"

/** The database volume. The root filesystem holds the OS, not the data the plan's disk size bounds. */
export const SUPABASE_DATA_MOUNTPOINT = "/data"

/** Postgres template databases are not the project's data. */
const TEMPLATE_DATABASES = ["template0", "template1"] as const

/** Counters can only be differenced against an earlier sample: two scrape intervals of lookback. */
const COUNTER_LOOKBACK_SECONDS = 120

/** Bucket width of the list's CPU peak. */
const CPU_PEAK_BUCKET_SECONDS = 300

const GAUGE_METRIC_NAMES = [
	SUPABASE_MEMORY_TOTAL,
	SUPABASE_MEMORY_AVAILABLE,
	SUPABASE_FS_SIZE,
	SUPABASE_FS_AVAILABLE,
	SUPABASE_DB_SIZE,
	SUPABASE_BACKENDS,
	SUPABASE_POOLER_CLIENTS,
	SUPABASE_AUTH_USERS,
	SUPABASE_POSTGREST_POOL_MAX,
	SUPABASE_POSTGREST_POOL_AVAILABLE,
	SUPABASE_POSTGREST_POOL_WAITING,
] as const

const COUNTER_METRIC_NAMES = [
	SUPABASE_CPU_SECONDS,
	SUPABASE_XACT_COMMIT,
	SUPABASE_XACT_ROLLBACK,
	SUPABASE_BLKS_HIT,
	SUPABASE_BLKS_READ,
	SUPABASE_NETWORK_RX,
	SUPABASE_NETWORK_TX,
	SUPABASE_DISK_READ,
	SUPABASE_DISK_WRITTEN,
] as const

type GaugeColumns = ColumnAccessor<typeof MetricsGauge.columns>

const isDataVolume = ($: GaugeColumns, metricName: string) =>
	$.MetricName.eq(metricName).and($.Attributes.get("mountpoint").eq(SUPABASE_DATA_MOUNTPOINT))

/**
 * One row per (project, timestamp). Exporters report at different instants, so a family absent
 * from a row reads 0: each family carries its sample count and aggregates skip rows without one.
 */
const gaugePoints = () =>
	from(MetricsGauge).select(($) => {
		const isDbSize = $.MetricName.eq(SUPABASE_DB_SIZE).and(
			CH.notInList($.Attributes.get("datname"), TEMPLATE_DATABASES),
		)
		// The exporter reports -1 when it cannot count the users.
		const isAuthUsers = $.MetricName.eq(SUPABASE_AUTH_USERS).and($.Value.gte(0))
		return {
			projectRef: $.Attributes.get(SUPABASE_PROJECT_REF_ATTRIBUTE),
			t: $.TimeUnix,
			memTotal: CH.maxIf($.Value, $.MetricName.eq(SUPABASE_MEMORY_TOTAL)),
			memAvailable: CH.maxIf($.Value, $.MetricName.eq(SUPABASE_MEMORY_AVAILABLE)),
			memAvailableSamples: CH.countIf($.MetricName.eq(SUPABASE_MEMORY_AVAILABLE)),
			diskSize: CH.maxIf($.Value, isDataVolume($, SUPABASE_FS_SIZE)),
			diskAvailable: CH.maxIf($.Value, isDataVolume($, SUPABASE_FS_AVAILABLE)),
			diskAvailableSamples: CH.countIf(isDataVolume($, SUPABASE_FS_AVAILABLE)),
			dbSize: CH.sumIf($.Value, isDbSize),
			dbSizeSamples: CH.countIf(isDbSize),
			backends: CH.sumIf($.Value, $.MetricName.eq(SUPABASE_BACKENDS)),
			backendSamples: CH.countIf($.MetricName.eq(SUPABASE_BACKENDS)),
			poolerClients: CH.sumIf($.Value, $.MetricName.eq(SUPABASE_POOLER_CLIENTS)),
			poolerSamples: CH.countIf($.MetricName.eq(SUPABASE_POOLER_CLIENTS)),
			authUsers: CH.maxIf($.Value, isAuthUsers),
			authSamples: CH.countIf(isAuthUsers),
			postgrestPoolMax: CH.sumIf($.Value, $.MetricName.eq(SUPABASE_POSTGREST_POOL_MAX)),
			postgrestPoolMaxSamples: CH.countIf($.MetricName.eq(SUPABASE_POSTGREST_POOL_MAX)),
			postgrestPoolAvailable: CH.sumIf($.Value, $.MetricName.eq(SUPABASE_POSTGREST_POOL_AVAILABLE)),
			postgrestPoolAvailableSamples: CH.countIf($.MetricName.eq(SUPABASE_POSTGREST_POOL_AVAILABLE)),
			postgrestPoolWaiting: CH.sumIf($.Value, $.MetricName.eq(SUPABASE_POSTGREST_POOL_WAITING)),
			postgrestPoolWaitingSamples: CH.countIf($.MetricName.eq(SUPABASE_POSTGREST_POOL_WAITING)),
		}
	})

/**
 * Per-sample increments of every counter series, reset-aware. One partition per series (its
 * labels and resource); the lookback lets the first in-window sample difference against one before it.
 */
const counterDeltas = () =>
	from(MetricsSum).select(($) => {
		const previous = CH.windowSpec({
			partitionBy: [
				$.MetricName,
				CH.cityHash64(CH.mapKeys($.Attributes), CH.mapValues($.Attributes)),
				CH.cityHash64(CH.mapKeys($.ResourceAttributes), CH.mapValues($.ResourceAttributes)),
			],
			orderBy: [[$.TimeUnix, "asc"]],
			frame: CH.rowsBetween(CH.preceding(1), CH.currentRow),
		})
		return {
			projectRef: $.Attributes.get(SUPABASE_PROJECT_REF_ATTRIBUTE),
			t: $.TimeUnix,
			metricName: $.MetricName,
			mode: $.Attributes.get("mode"),
			device: $.Attributes.get("device"),
			delta: metricDeltaExpr({
				value: $.Value,
				previousValue: CH.over(CH.lagInFrame($.Value, 1, $.Value), previous),
				startTime: $.StartTimeUnix,
				previousTime: CH.over(CH.lagInFrame($.TimeUnix, 1, $.TimeUnix), previous),
				time: $.TimeUnix,
				// Delta-temporality rows already are increments.
				isDeltaTemporality: CH.dynamicColumn<number>("AggregationTemporality").eq(1),
			}),
		}
	})

/** `1 - available / total`: the share in use. Callers guard `total > 0`. */
const usedShare = (available: CH.Expr<number>, total: CH.Expr<number>) => CH.lit(1).sub(available.div(total))

const counterWindowStart = () => CH.intervalSub(param.dateTime("startTime"), COUNTER_LOOKBACK_SECONDS)

// PROJECTS

export interface SupabaseProjectGaugesOutput {
	readonly projectRef: string
	readonly memoryAvg: number
	readonly memoryMax: number
	readonly memoryTotal: number
	readonly diskUsedMax: number
	readonly diskSize: number
	readonly dbSize: number
	readonly connectionsAvg: number
	readonly connectionsMax: number
	readonly lastSeen: DateTime.Utc
}

/** One row per project over the window: memory and disk use (0..1), database size, connections. */
export function supabaseProjectGaugesSQL() {
	const points = gaugePoints()
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.MetricName.in_(...GAUGE_METRIC_NAMES),
			$.Attributes.get(SUPABASE_PROJECT_REF_ATTRIBUTE).neq(""),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
		])
		.groupBy("projectRef", "t")

	return fromQuery(points, "points")
		.select(($) => ({
			projectRef: $.projectRef,
			memoryAvg: finiteOrZero(
				CH.avgIf(
					usedShare($.memAvailable, $.memTotal),
					$.memTotal.gt(0).and($.memAvailableSamples.gt(0)),
				),
			),
			memoryMax: finiteOrZero(
				CH.maxIf(
					usedShare($.memAvailable, $.memTotal),
					$.memTotal.gt(0).and($.memAvailableSamples.gt(0)),
				),
			),
			memoryTotal: CH.max_($.memTotal),
			diskUsedMax: finiteOrZero(
				CH.maxIf(
					usedShare($.diskAvailable, $.diskSize),
					$.diskSize.gt(0).and($.diskAvailableSamples.gt(0)),
				),
			),
			diskSize: CH.max_($.diskSize),
			dbSize: CH.maxIf($.dbSize, $.dbSizeSamples.gt(0)),
			connectionsAvg: finiteOrZero(CH.avgIf($.backends, $.backendSamples.gt(0))),
			connectionsMax: CH.maxIf($.backends, $.backendSamples.gt(0)),
			lastSeen: CH.max_($.t),
		}))
		.groupBy("projectRef")
		.orderBy(["projectRef", "asc"])
		.limit(1000)
		.format("JSON")
}

export interface SupabaseProjectCpuOutput {
	readonly projectRef: string
	readonly cpuAvg: number
	readonly cpuMax: number
}

/**
 * CPU busy share (0..1) per project: `1 - idle / all` over `node_cpu_seconds_total` increments,
 * across every core and mode. The peak is the busiest five minutes.
 */
export function supabaseProjectCpuSQL() {
	const deltas = counterDeltas().where(($) => [
		$.OrgId.eq(orgIdParam),
		$.MetricName.eq(SUPABASE_CPU_SECONDS),
		$.Attributes.get(SUPABASE_PROJECT_REF_ATTRIBUTE).neq(""),
		$.TimeUnix.gte(counterWindowStart()),
		$.TimeUnix.lte(param.dateTime("endTime")),
	])

	const buckets = fromQuery(deltas, "deltas")
		.select(($) => ({
			projectRef: $.projectRef,
			bucket: CH.toStartOfInterval($.t, CPU_PEAK_BUCKET_SECONDS),
			idle: CH.sumIf($.delta, $.mode.eq("idle")),
			total: CH.sum($.delta),
		}))
		.where(($) => [$.t.gte(param.dateTime("startTime"))])
		.groupBy("projectRef", "bucket")

	return fromQuery(buckets, "buckets")
		.select(($) => ({
			projectRef: $.projectRef,
			cpuAvg: finiteOrZero(CH.greatest_(CH.lit(1).sub(CH.sum($.idle).div(CH.sum($.total))), CH.lit(0))),
			cpuMax: finiteOrZero(CH.maxIf(CH.lit(1).sub($.idle.div($.total)), $.total.gt(0))),
		}))
		.groupBy("projectRef")
		.orderBy(["projectRef", "asc"])
		.limit(1000)
		.format("JSON")
}

// ONE PROJECT

export interface SupabaseProjectGaugeSeriesOutput {
	readonly bucket: DateTime.Utc
	readonly memoryAvg: number
	readonly memoryMax: number
	readonly memoryTotal: number
	readonly diskUsed: number
	readonly diskSize: number
	readonly dbSize: number
	readonly connectionsAvg: number
	readonly connectionsMax: number
	readonly poolerClients: number
	readonly authUsers: number
	readonly authSamples: number
	readonly postgrestPoolMax: number
	readonly postgrestPoolInUse: number
	readonly postgrestPoolWaiting: number
}

/** Bucketed gauges for one project. Memory and disk are shares (0..1); sizes are bytes. */
export function supabaseProjectGaugeSeriesSQL() {
	const points = gaugePoints()
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.MetricName.in_(...GAUGE_METRIC_NAMES),
			$.Attributes.get(SUPABASE_PROJECT_REF_ATTRIBUTE).eq(param.string("projectRef")),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
		])
		.groupBy("projectRef", "t")

	return fromQuery(points, "points")
		.select(($) => ({
			bucket: CH.toStartOfInterval($.t, param.int("bucketSeconds")),
			memoryAvg: finiteOrZero(
				CH.avgIf(
					usedShare($.memAvailable, $.memTotal),
					$.memTotal.gt(0).and($.memAvailableSamples.gt(0)),
				),
			),
			memoryMax: finiteOrZero(
				CH.maxIf(
					usedShare($.memAvailable, $.memTotal),
					$.memTotal.gt(0).and($.memAvailableSamples.gt(0)),
				),
			),
			memoryTotal: CH.max_($.memTotal),
			diskUsed: finiteOrZero(
				CH.maxIf(
					usedShare($.diskAvailable, $.diskSize),
					$.diskSize.gt(0).and($.diskAvailableSamples.gt(0)),
				),
			),
			diskSize: CH.max_($.diskSize),
			dbSize: CH.maxIf($.dbSize, $.dbSizeSamples.gt(0)),
			connectionsAvg: finiteOrZero(CH.avgIf($.backends, $.backendSamples.gt(0))),
			connectionsMax: CH.maxIf($.backends, $.backendSamples.gt(0)),
			poolerClients: finiteOrZero(CH.avgIf($.poolerClients, $.poolerSamples.gt(0))),
			authUsers: CH.max_($.authUsers),
			authSamples: CH.sum($.authSamples),
			postgrestPoolMax: CH.maxIf($.postgrestPoolMax, $.postgrestPoolMaxSamples.gt(0)),
			// In use = max - available, per scrape with both, averaged over the bucket.
			postgrestPoolInUse: finiteOrZero(
				CH.avgIf(
					CH.greatest_($.postgrestPoolMax.sub($.postgrestPoolAvailable), CH.lit(0)),
					$.postgrestPoolMaxSamples.gt(0).and($.postgrestPoolAvailableSamples.gt(0)),
				),
			),
			postgrestPoolWaiting: CH.maxIf($.postgrestPoolWaiting, $.postgrestPoolWaitingSamples.gt(0)),
		}))
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.limit(2000)
		.format("JSON")
}

export interface SupabaseProjectRateSeriesOutput {
	readonly bucket: DateTime.Utc
	readonly cpu: number
	readonly commitsPerSecond: number
	readonly rollbacksPerSecond: number
	/** Null for a bucket with no block reads: there is no ratio to draw. */
	readonly cacheHitRatio: number | null
	readonly networkRxPerSecond: number
	readonly networkTxPerSecond: number
	readonly diskReadPerSecond: number
	readonly diskWritePerSecond: number
}

/**
 * Bucketed counter rates for one project: each bucket's summed increments over the seconds of the
 * bucket inside the window (edge buckets are partial). CPU and cache hit are ratios of increments.
 */
export function supabaseProjectRateSeriesSQL() {
	const deltas = counterDeltas().where(($) => [
		$.OrgId.eq(orgIdParam),
		$.MetricName.in_(...COUNTER_METRIC_NAMES),
		$.Attributes.get(SUPABASE_PROJECT_REF_ATTRIBUTE).eq(param.string("projectRef")),
		$.TimeUnix.gte(counterWindowStart()),
		$.TimeUnix.lte(param.dateTime("endTime")),
	])

	return fromQuery(deltas, "deltas")
		.select(($) => {
			const bucketStart = CH.toUnixTimestamp(CH.toStartOfInterval($.t, param.int("bucketSeconds")))
			const rangeStart = CH.toUnixTimestamp(CH.toDateTime(utcSecondsParam("startTime")))
			const rangeEnd = CH.toUnixTimestamp(CH.toDateTime(utcSecondsParam("endTime")))
			// `min_` wraps the width in a call: the builder does not parenthesize arithmetic.
			const covered = CH.min_(
				CH.least_(bucketStart.add(param.int("bucketSeconds")), rangeEnd).sub(
					CH.greatest_(bucketStart, rangeStart),
				),
			)
			const perSecond = (condition: CH.Condition) =>
				finiteOrZero(CH.sumIf($.delta, condition).div(covered))
			const isNetwork = (metricName: string) => $.metricName.eq(metricName).and($.device.neq("lo"))
			return {
				bucket: CH.toStartOfInterval($.t, param.int("bucketSeconds")),
				cpu: finiteOrZero(
					CH.greatest_(
						CH.lit(1).sub(
							CH.sumIf(
								$.delta,
								$.metricName.eq(SUPABASE_CPU_SECONDS).and($.mode.eq("idle")),
							).div(CH.sumIf($.delta, $.metricName.eq(SUPABASE_CPU_SECONDS))),
						),
						CH.lit(0),
					),
				),
				commitsPerSecond: perSecond($.metricName.eq(SUPABASE_XACT_COMMIT)),
				rollbacksPerSecond: perSecond($.metricName.eq(SUPABASE_XACT_ROLLBACK)),
				cacheHitRatio: CH.sumIf($.delta, $.metricName.eq(SUPABASE_BLKS_HIT)).div(
					CH.nullIf(CH.sumIf($.delta, $.metricName.in_(SUPABASE_BLKS_HIT, SUPABASE_BLKS_READ)), 0),
				),
				networkRxPerSecond: perSecond(isNetwork(SUPABASE_NETWORK_RX)),
				networkTxPerSecond: perSecond(isNetwork(SUPABASE_NETWORK_TX)),
				diskReadPerSecond: perSecond($.metricName.eq(SUPABASE_DISK_READ)),
				diskWritePerSecond: perSecond($.metricName.eq(SUPABASE_DISK_WRITTEN)),
			}
		})
		.where(($) => [$.t.gte(param.dateTime("startTime"))])
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.limit(2000)
		.format("JSON")
}
