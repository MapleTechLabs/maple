import { windowDurationSeconds } from "@maple/query-engine"
import { gcpWindowPoints } from "@maple/web/components/infra/gcp/charts"
import {
	gcpCloudSqlView,
	gcpQueryInsightsUnavailable,
	gcpStatements,
	type GcpStatement,
} from "@maple/web/components/infra/gcp/cloud-sql-signals"
import {
	gcpCloudSqlInstances,
	gcpMatchResource,
	gcpWorkloadTelemetry,
} from "@maple/web/components/infra/gcp/inventory"
import { gcpDatabaseRows, gcpSqlEngineOf, NO_GCP_SPARKS } from "@maple/web/components/infra/gcp/list-model"
import { gcpWorkload, gcpWorkloadTone } from "@maple/web/components/infra/gcp/tabs"
import { gcpRailFacts, gcpTraceGap, gcpTracedErrors } from "@maple/web/components/infra/gcp/workload-signals"
import { chartBucketSeconds } from "../../../../charts/infra-metric-series"
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
	const tracedService = tracedErrors === null ? null : telemetry.serviceName
	const gap = gcpTraceGap(model.service, points, bucketSeconds, tracedErrors)
	const isCloudSql = model.service === "cloudSql"
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
	const facts = sql?.facts ?? gcpRailFacts(model.service, points, bucketSeconds)
	const databaseVersion = isCloudSql ? (instance?.databaseVersion ?? gcpSqlEngineOf(points)) : undefined
	const health =
		points.length === 0
			? null
			: gcpWorkloadTone(gcpWorkload(model.service, keys, gcpWindowPoints(points)))
	return {
		keys,
		points,
		bucketSeconds,
		resource,
		telemetry,
		overviewLoaded: overview !== null,
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

export type PageData = ReturnType<typeof pageOf>
