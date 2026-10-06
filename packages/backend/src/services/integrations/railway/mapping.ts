/**
 * Railway `metrics` series → OTel gauge rows. One resource per (service, replica); every
 * measurement is a point-in-time sample, so all of them land as gauges.
 */
import {
	fmtMetricTs,
	type MetricAttrs,
	type MetricGaugeRow,
} from "@maple/backend/services/warehouse/metric-rows"
import type { RailwayMeasurement, RailwayMetricsResult } from "./api"

export const RAILWAY_SCOPE_NAME = "maple.railway"

export const METRIC_CPU_USAGE = "railway.cpu.usage"
export const METRIC_CPU_LIMIT = "railway.cpu.limit"
export const METRIC_MEMORY_USAGE = "railway.memory.usage"
export const METRIC_MEMORY_LIMIT = "railway.memory.limit"
export const METRIC_NETWORK_IO = "railway.network.io"
export const METRIC_DISK_USAGE = "railway.disk.usage"

/** Railway reports "GB" as binary gigabytes (its CLI multiplies by 1024 to show MB). */
const GIB = 1024 ** 3

interface MeasurementDef {
	readonly name: string
	readonly unit: string
	readonly description: string
	readonly scale: number
	readonly attributes: MetricAttrs
}

const MEASUREMENTS = {
	CPU_USAGE: {
		name: METRIC_CPU_USAGE,
		unit: "{cpu}",
		description: "vCPU in use, averaged over the sample interval",
		scale: 1,
		attributes: {},
	},
	CPU_LIMIT: {
		name: METRIC_CPU_LIMIT,
		unit: "{cpu}",
		description: "vCPU limit of the replica",
		scale: 1,
		attributes: {},
	},
	MEMORY_USAGE_GB: {
		name: METRIC_MEMORY_USAGE,
		unit: "By",
		description: "Memory in use",
		scale: GIB,
		attributes: {},
	},
	MEMORY_LIMIT_GB: {
		name: METRIC_MEMORY_LIMIT,
		unit: "By",
		description: "Memory limit of the replica",
		scale: GIB,
		attributes: {},
	},
	NETWORK_RX_GB: {
		name: METRIC_NETWORK_IO,
		unit: "By",
		description: "Network traffic as reported by Railway",
		scale: GIB,
		attributes: { "network.io.direction": "receive" },
	},
	NETWORK_TX_GB: {
		name: METRIC_NETWORK_IO,
		unit: "By",
		description: "Network traffic as reported by Railway",
		scale: GIB,
		attributes: { "network.io.direction": "transmit" },
	},
	DISK_USAGE_GB: {
		name: METRIC_DISK_USAGE,
		unit: "By",
		description: "Disk in use",
		scale: GIB,
		attributes: { "railway.disk.kind": "volume" },
	},
	EPHEMERAL_DISK_USAGE_GB: {
		name: METRIC_DISK_USAGE,
		unit: "By",
		description: "Disk in use",
		scale: GIB,
		attributes: { "railway.disk.kind": "ephemeral" },
	},
} satisfies Record<RailwayMeasurement, MeasurementDef>

const MEASUREMENT_BY_NAME = new Map<string, MeasurementDef>(Object.entries(MEASUREMENTS))

export interface RailwayEnvironmentContext {
	readonly projectId: string
	readonly projectName: string
	readonly environmentId: string
	readonly environmentName: string
	readonly services: Readonly<Record<string, string>>
}

/**
 * `service.name` is the Railway service name, so metrics line up with traces whenever the app
 * names its OTel service the same way; the `railway.*` ids stay authoritative either way.
 */
export const railwayResourceAttributes = (
	context: RailwayEnvironmentContext,
	serviceId: string,
	replicaId: string | null,
	region: string | null,
): MetricAttrs => {
	const serviceName = context.services[serviceId] ?? serviceId
	return {
		"service.name": serviceName,
		"cloud.provider": "railway",
		...(region ? { "cloud.region": region } : undefined),
		"deployment.environment": context.environmentName,
		"deployment.environment.name": context.environmentName,
		"railway.project.id": context.projectId,
		"railway.project.name": context.projectName,
		"railway.environment.id": context.environmentId,
		"railway.environment.name": context.environmentName,
		"railway.service.id": serviceId,
		"railway.service.name": serviceName,
		...(replicaId ? { "railway.replica.id": replicaId } : undefined),
	}
}

/**
 * Keep samples with `startMs <= ts < endMs` so consecutive windows never emit the same point.
 * Series without a service id (project-level rollups) and unknown measurements are dropped.
 */
export const mapRailwayMetrics = (
	context: RailwayEnvironmentContext,
	results: ReadonlyArray<RailwayMetricsResult>,
	window: { readonly startMs: number; readonly endMs: number },
): Array<MetricGaugeRow> => {
	const rows: Array<MetricGaugeRow> = []
	for (const result of results) {
		const def = MEASUREMENT_BY_NAME.get(result.measurement)
		const serviceId = result.tags.serviceId
		if (def === undefined || !serviceId) continue
		const resourceAttributes = railwayResourceAttributes(
			context,
			serviceId,
			result.tags.deploymentInstanceId ?? null,
			result.tags.region ?? null,
		)
		for (const point of result.values) {
			const tsMs = point.ts * 1000
			if (tsMs < window.startMs || tsMs >= window.endMs || !Number.isFinite(point.value)) continue
			const ts = fmtMetricTs(tsMs)
			rows.push({
				timestamp: ts,
				start_timestamp: ts,
				metric_name: def.name,
				metric_description: def.description,
				metric_unit: def.unit,
				metric_attributes: def.attributes,
				service_name: resourceAttributes["service.name"] ?? serviceId,
				resource_schema_url: "",
				resource_attributes: resourceAttributes,
				scope_schema_url: "",
				scope_name: RAILWAY_SCOPE_NAME,
				scope_version: "",
				scope_attributes: {},
				value: point.value * def.scale,
				flags: 0,
				exemplars_trace_id: [],
				exemplars_span_id: [],
				exemplars_timestamp: [],
				exemplars_value: [],
				exemplars_filtered_attributes: [],
			})
		}
	}
	return rows
}
