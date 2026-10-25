import type { GcpInfraServiceId } from "@maple/domain/gcp-infra"
import type { GcpResource } from "@maple/domain/http"
import { windowDurationSeconds } from "@maple/query-engine"
import { type GcpBucketPoint, gcpWindowPoints } from "../../../../components/infra/gcp/charts"
import {
	gcpCloudSqlView,
	gcpQueryInsightsUnavailable,
	gcpStatements,
	type GcpStatement,
} from "../../../../components/infra/gcp/cloud-sql-signals"
import {
	type GcpCloudSqlInstance,
	gcpCloudSqlInstances,
	gcpMatchResource,
	gcpWorkloadTelemetry,
} from "../../../../components/infra/gcp/inventory"
import {
	gcpDatabaseRows,
	type GcpReplica,
	gcpSqlEngineOf,
	NO_GCP_SPARKS,
} from "../../../../components/infra/gcp/list-model"
import { gcpWorkload, gcpWorkloadTone } from "../../../../components/infra/gcp/tabs"
import { gcpRailFacts, gcpTraceGap, gcpTracedErrors } from "../../../../components/infra/gcp/workload-signals"
import { chartBucketSeconds } from "../../../../charts/infra-metric-series"
import type { TraceSide } from "../data"
import { successOf } from "../list/derive"
import type { Model } from "./model"
import { keysOf } from "./update"

// The workload page's derivations (`GcpWorkloadPage`, `GcpCloudSqlPage`).

const NO_STATEMENTS: ReadonlyArray<GcpStatement> = []

export const pointsOf = (model: Model) => successOf(model.timeseries.data) ?? []

export const bucketSecondsOf = (model: Model) =>
	model.window === null ? 300 : chartBucketSeconds(model.window.startTime, model.window.endTime)

export const pageOf = (model: Model) => {
	const keys = keysOf(model)
	const points = pointsOf(model)
	const bucketSeconds = bucketSecondsOf(model)
	const window = model.window
	const resources = successOf(model.resource.data)
	const resource =
		resources === null ? undefined : gcpMatchResource(model.service, keys, resources.resources)
	const telemetry = gcpWorkloadTelemetry(model.service, keys)
	const overview = successOf(model.overview.data)
	const tracedErrors =
		telemetry.traced && overview !== null && window !== null
			? gcpTracedErrors(
					overview,
					telemetry.serviceName,
					windowDurationSeconds(window.startTime, window.endTime),
				)
			: null
	const inventory = successOf(model.sqlInventory.data)
	const instances = inventory === null ? undefined : gcpCloudSqlInstances(inventory.resources)
	const instance = instances?.find((candidate) => candidate.id === model.name)
	const fleet = successOf(model.fleet.data)
	const replicas =
		fleet === null
			? []
			: (gcpDatabaseRows(fleet, NO_GCP_SPARKS, instances).find((row) => row.keys[0] === model.name)
					?.replicas ?? [])
	const traceSide = successOf(model.traceSide.data) ?? undefined
	const statementsRaw = successOf(model.topQueries.data)
	const statements = statementsRaw === null ? NO_STATEMENTS : gcpStatements(statementsRaw, points)
	return workloadData({
		service: model.service,
		keys,
		points,
		bucketSeconds,
		resource,
		overviewLoaded: overview !== null,
		tracedErrors,
		instance,
		traceSide,
		statements,
		replicas,
	})
}

/** What `GcpWorkloadPage` is handed, read off the slots by the route and off fixtures by the lab. */
export type WorkloadInputs = Readonly<{
	service: GcpInfraServiceId
	keys: ReadonlyArray<string>
	points: ReadonlyArray<GcpBucketPoint>
	bucketSeconds: number
	resource: GcpResource | undefined
	overviewLoaded: boolean
	/** Errors on the traced service's entry spans; null when nothing of this name sends spans. */
	tracedErrors: number | null
	instance: GcpCloudSqlInstance | undefined
	traceSide: TraceSide | undefined
	statements: ReadonlyArray<GcpStatement>
	replicas: ReadonlyArray<GcpReplica>
}>

export const workloadData = (input: WorkloadInputs) => {
	const { service, keys, points, bucketSeconds, resource, instance, traceSide, statements } = input
	const telemetry = gcpWorkloadTelemetry(service, keys)
	const tracedService = input.tracedErrors === null ? null : telemetry.serviceName
	const gap = gcpTraceGap(service, points, bucketSeconds, input.tracedErrors)
	const isCloudSql = service === "cloudSql"
	const replicas = input.replicas
	const sql = isCloudSql
		? gcpCloudSqlView({
				instance,
				statements,
				tracedQueries: traceSide?.tracedQueries ?? [],
				databases: traceSide?.databases,
				replicas,
				points,
				bucketSeconds,
			})
		: undefined
	const facts = sql?.facts ?? gcpRailFacts(service, points, bucketSeconds)
	const databaseVersion = isCloudSql ? (instance?.databaseVersion ?? gcpSqlEngineOf(points)) : undefined
	const health =
		points.length === 0 ? null : gcpWorkloadTone(gcpWorkload(service, keys, gcpWindowPoints(points)))
	return {
		keys,
		points,
		bucketSeconds,
		resource,
		telemetry,
		overviewLoaded: input.overviewLoaded,
		tracedService,
		gap,
		isCloudSql,
		instance,
		traceSide,
		statements,
		unavailableReason: gcpQueryInsightsUnavailable(instance),
		sql,
		facts,
		databaseVersion,
		health,
	}
}

export type PageData = ReturnType<typeof workloadData>
