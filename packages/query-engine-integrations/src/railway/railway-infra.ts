// Railway infrastructure page (/infra/railway)
//
// Reads the `railway.*` gauges the Railway poller ingests (one resource per service replica).
// A Railway service id is shared by every environment of its project, so a service here is the
// (environment, service) pair. Replicas are summed per timestamp before bucketing.

import { finiteOrZero } from "@maple/query-engine/ch/format"
import * as CH from "@maple-dev/effect-clickhouse/expr"
import { from, fromQuery, param } from "@maple-dev/effect-clickhouse"
import { MetricsGauge } from "@maple/query-engine/ch/tables"

export const RAILWAY_CPU_USAGE = "railway.cpu.usage"
export const RAILWAY_CPU_LIMIT = "railway.cpu.limit"
export const RAILWAY_MEMORY_USAGE = "railway.memory.usage"
export const RAILWAY_MEMORY_LIMIT = "railway.memory.limit"
export const RAILWAY_NETWORK_IO = "railway.network.io"
export const RAILWAY_DISK_USAGE = "railway.disk.usage"

const RAILWAY_METRIC_NAMES = [
	RAILWAY_CPU_USAGE,
	RAILWAY_CPU_LIMIT,
	RAILWAY_MEMORY_USAGE,
	RAILWAY_MEMORY_LIMIT,
	RAILWAY_NETWORK_IO,
	RAILWAY_DISK_USAGE,
] as const

export interface RailwayServicesOutput {
	readonly environmentId: string
	readonly serviceId: string
	readonly serviceName: string
	readonly projectName: string
	readonly environmentName: string
	readonly cpuAvg: number
	readonly cpuMax: number
	readonly cpuLimit: number
	readonly memoryAvg: number
	readonly memoryMax: number
	readonly memoryLimit: number
	readonly replicas: number
	readonly lastSeen: string
}

/** One row per (environment, service) over the window: usage against limits, replica count. */
export function railwayServicesSQL() {
	const points = from(MetricsGauge)
		.select(($) => ({
			environmentId: $.ResourceAttributes.get("railway.environment.id"),
			serviceId: $.ResourceAttributes.get("railway.service.id"),
			t: $.TimeUnix,
			serviceName: CH.any_($.ServiceName),
			projectName: CH.any_($.ResourceAttributes.get("railway.project.name")),
			environmentName: CH.any_($.ResourceAttributes.get("railway.environment.name")),
			cpu: CH.sumIf($.Value, $.MetricName.eq(RAILWAY_CPU_USAGE)),
			cpuLimit: CH.sumIf($.Value, $.MetricName.eq(RAILWAY_CPU_LIMIT)),
			memory: CH.sumIf($.Value, $.MetricName.eq(RAILWAY_MEMORY_USAGE)),
			memoryLimit: CH.sumIf($.Value, $.MetricName.eq(RAILWAY_MEMORY_LIMIT)),
			replicas: CH.uniqIf(
				$.ResourceAttributes.get("railway.replica.id"),
				$.MetricName.eq(RAILWAY_CPU_USAGE),
			),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.MetricName.in_(...RAILWAY_METRIC_NAMES),
			$.TimeUnix.gte(param.dateTimeString("startTime")),
			$.TimeUnix.lte(param.dateTimeString("endTime")),
		])
		.groupBy("environmentId", "serviceId", "t")

	return fromQuery(points, "points")
		.select(($) => ({
			environmentId: $.environmentId,
			serviceId: $.serviceId,
			serviceName: CH.any_($.serviceName),
			projectName: CH.any_($.projectName),
			environmentName: CH.any_($.environmentName),
			cpuAvg: finiteOrZero(CH.avg($.cpu)),
			cpuMax: CH.max_($.cpu),
			cpuLimit: CH.max_($.cpuLimit),
			memoryAvg: finiteOrZero(CH.avg($.memory)),
			memoryMax: CH.max_($.memory),
			memoryLimit: CH.max_($.memoryLimit),
			replicas: CH.max_($.replicas),
			lastSeen: CH.max_($.t),
		}))
		.groupBy("environmentId", "serviceId")
		.orderBy(["projectName", "asc"], ["environmentName", "asc"], ["serviceName", "asc"])
		.limit(1000)
		.format("JSON")
}

export interface RailwayServiceTimeseriesOutput {
	readonly bucket: string
	readonly cpuAvg: number
	readonly cpuMax: number
	readonly cpuLimit: number
	readonly memoryAvg: number
	readonly memoryMax: number
	readonly memoryLimit: number
	readonly networkRx: number
	readonly networkTx: number
	readonly diskVolume: number
	readonly diskEphemeral: number
	readonly replicas: number
}

/** Bucketed resource timeseries for one Railway service in one environment. */
export function railwayServiceTimeseriesSQL() {
	const points = from(MetricsGauge)
		.select(($) => ({
			t: $.TimeUnix,
			cpu: CH.sumIf($.Value, $.MetricName.eq(RAILWAY_CPU_USAGE)),
			cpuLimit: CH.sumIf($.Value, $.MetricName.eq(RAILWAY_CPU_LIMIT)),
			memory: CH.sumIf($.Value, $.MetricName.eq(RAILWAY_MEMORY_USAGE)),
			memoryLimit: CH.sumIf($.Value, $.MetricName.eq(RAILWAY_MEMORY_LIMIT)),
			networkRx: CH.sumIf(
				$.Value,
				$.MetricName.eq(RAILWAY_NETWORK_IO).and(
					$.Attributes.get("network.io.direction").eq("receive"),
				),
			),
			networkTx: CH.sumIf(
				$.Value,
				$.MetricName.eq(RAILWAY_NETWORK_IO).and(
					$.Attributes.get("network.io.direction").eq("transmit"),
				),
			),
			// A volume is attached to the service, not a replica: take it once.
			diskVolume: CH.maxIf(
				$.Value,
				$.MetricName.eq(RAILWAY_DISK_USAGE).and($.Attributes.get("railway.disk.kind").eq("volume")),
			),
			diskEphemeral: CH.sumIf(
				$.Value,
				$.MetricName.eq(RAILWAY_DISK_USAGE).and(
					$.Attributes.get("railway.disk.kind").eq("ephemeral"),
				),
			),
			replicas: CH.uniqIf(
				$.ResourceAttributes.get("railway.replica.id"),
				$.MetricName.eq(RAILWAY_CPU_USAGE),
			),
		}))
		.where(($) => [
			$.OrgId.eq(param.string("orgId")),
			$.MetricName.in_(...RAILWAY_METRIC_NAMES),
			$.ResourceAttributes.get("railway.environment.id").eq(param.string("environmentId")),
			$.ResourceAttributes.get("railway.service.id").eq(param.string("serviceId")),
			$.TimeUnix.gte(param.dateTimeString("startTime")),
			$.TimeUnix.lte(param.dateTimeString("endTime")),
		])
		.groupBy("t")

	return fromQuery(points, "points")
		.select(($) => ({
			bucket: CH.toStartOfInterval($.t, param.int("bucketSeconds")),
			cpuAvg: finiteOrZero(CH.avg($.cpu)),
			cpuMax: CH.max_($.cpu),
			cpuLimit: CH.max_($.cpuLimit),
			memoryAvg: finiteOrZero(CH.avg($.memory)),
			memoryMax: CH.max_($.memory),
			memoryLimit: CH.max_($.memoryLimit),
			networkRx: finiteOrZero(CH.avg($.networkRx)),
			networkTx: finiteOrZero(CH.avg($.networkTx)),
			diskVolume: CH.max_($.diskVolume),
			diskEphemeral: CH.max_($.diskEphemeral),
			replicas: CH.max_($.replicas),
		}))
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.limit(2000)
		.format("JSON")
}
