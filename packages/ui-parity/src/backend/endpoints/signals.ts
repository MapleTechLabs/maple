import { DateTime, Effect, Schema } from "effect"
import {
	ErrorDetailTracesRequest,
	ErrorDetailTracesResponse,
	ErrorRateByServiceRequest,
	ErrorRateByServiceResponse,
	ErrorsByTypeRequest,
	ErrorsByTypeResponse,
	ErrorsSparkRequest,
	ErrorsSparkResponse,
	ErrorsSummaryRequest,
	ErrorsSummaryResponse,
	FingerprintHash,
	InfraPresenceRequest,
	InfraPresenceResponse,
	InfraSurfaceLiteral,
	ListLogsRequest,
	ListLogsResponse,
	ListMetricsRequest,
	ListMetricsResponse,
	MetricsSummaryRequest,
	MetricsSummaryResponse,
	ProductEventNamesRequest,
	ProductEventNamesResponse,
	RawSqlExecuteRequest,
	RawSqlExecuteResponse,
	ServiceName,
	TraceId,
} from "@maple/domain/http"
import { computeBucketSecondsForRange } from "@maple/query-engine"
import { Queries } from "@maple/query-engine/registry"
import { makeExecuteRawSql } from "@maple/query-engine/runtime"
import type { EndpointHandler } from "../../fixtures/dataset.ts"
import type { FixtureWarehouse } from "../warehouse.ts"
import { warehouseEndpoint } from "./run.ts"

/** Errors, logs, metrics, infra presence and raw SQL endpoints of `HttpQueryEngineLive`. */

const decodeFingerprintHash = Schema.decodeUnknownSync(FingerprintHash)
const decodeTraceId = Schema.decodeSync(TraceId)
const decodeServiceName = Schema.decodeUnknownSync(ServiceName)
const isInfraSurface = Schema.is(InfraSurfaceLiteral)

const errorEndpoints = (warehouse: FixtureWarehouse): Readonly<Record<string, EndpointHandler>> => ({
	"queryEngine.errorsByType": warehouseEndpoint(warehouse, ErrorsByTypeRequest, ErrorsByTypeResponse, (payload, { runQuery }) =>
		Effect.map(
			runQuery(Queries.errorsByType, payload),
			(rows) =>
				new ErrorsByTypeResponse({
					data: rows.map((row) => ({
						fingerprintHash: decodeFingerprintHash(row.fingerprintHash),
						errorLabel: row.errorLabel,
						sampleMessage: row.sampleMessage,
						count: row.count,
						affectedServicesCount: row.affectedServicesCount,
						firstSeen: DateTime.formatIso(row.firstSeen),
						lastSeen: DateTime.formatIso(row.lastSeen),
					})),
				}),
		),
	),
	"queryEngine.errorsSpark": warehouseEndpoint(warehouse, ErrorsSparkRequest, ErrorsSparkResponse, (payload, { runQuery }) =>
		Effect.map(
			runQuery(Queries.errorsSpark, payload),
			(rows) =>
				new ErrorsSparkResponse({
					data: rows.map((row) => ({
						fingerprintHash: decodeFingerprintHash(row.fingerprintHash),
						bucket: DateTime.formatIso(row.bucket),
						count: row.count,
					})),
				}),
		),
	),
	"queryEngine.errorsSummary": warehouseEndpoint(warehouse, ErrorsSummaryRequest, ErrorsSummaryResponse, (payload, { runQueryFirst }) =>
		Effect.map(
			runQueryFirst(Queries.errorsSummary, payload),
			(row) =>
				new ErrorsSummaryResponse({
					data: row
						? {
								totalErrors: row.totalErrors,
								totalSpans: row.totalSpans,
								errorRate: row.errorRate,
								affectedServicesCount: row.affectedServicesCount,
								affectedTracesCount: row.affectedTracesCount,
							}
						: null,
				}),
		),
	),
	"queryEngine.errorDetailTraces": warehouseEndpoint(
		warehouse,
		ErrorDetailTracesRequest,
		ErrorDetailTracesResponse,
		(payload, { runQuery }) =>
			Effect.map(
				runQuery(Queries.errorDetailTraces, payload),
				(rows) =>
					new ErrorDetailTracesResponse({
						data: rows.map((row) => ({
							traceId: decodeTraceId(row.traceId),
							startTime: DateTime.formatIso(row.startTime),
							durationMicros: row.durationMicros,
							spanCount: row.spanCount,
							services: row.services.map((service) => decodeServiceName(service)),
							rootSpanName: row.rootSpanName,
							errorMessage: row.errorMessage,
						})),
					}),
			),
	),
	"queryEngine.errorRateByService": warehouseEndpoint(
		warehouse,
		ErrorRateByServiceRequest,
		ErrorRateByServiceResponse,
		(payload, { runQuery }) =>
			Effect.map(
				runQuery(Queries.errorRateByService, payload),
				(rows) =>
					new ErrorRateByServiceResponse({
						data: rows.map((row) => ({
							serviceName: decodeServiceName(row.serviceName),
							totalLogs: row.totalLogs,
							errorLogs: row.errorLogs,
							errorRate: row.errorRate,
						})),
					}),
			),
	),
})

/** The audit write (`recordRawSqlAudit`) is left out: the fixture has no audit log. */
const rawSqlEndpoint = (warehouse: FixtureWarehouse) => {
	const executeRawSql = makeExecuteRawSql(warehouse.executor)
	return warehouseEndpoint(warehouse, RawSqlExecuteRequest, RawSqlExecuteResponse, (payload, { tenant }) =>
		Effect.map(
			executeRawSql(tenant, {
				sql: payload.sql,
				orgId: tenant.orgId,
				startTime: payload.startTime,
				endTime: payload.endTime,
				granularitySeconds:
					payload.granularitySeconds ?? computeBucketSecondsForRange(payload.startTime, payload.endTime, "rawSql"),
				workload: "interactive",
				context: "rawSql",
			}),
			(result) =>
				new RawSqlExecuteResponse({
					data: result.rows,
					meta: { rowCount: result.rowCount, columns: result.columns, granularitySeconds: result.granularitySeconds },
				}),
		),
	)
}

export const signalEndpoints = (warehouse: FixtureWarehouse): Readonly<Record<string, EndpointHandler>> => ({
	...errorEndpoints(warehouse),
	"queryEngine.listLogs": warehouseEndpoint(warehouse, ListLogsRequest, ListLogsResponse, (payload, { runQuery }) =>
		Effect.map(runQuery(Queries.listLogs, payload), (rows) => new ListLogsResponse({ data: rows })),
	),
	"queryEngine.listMetrics": warehouseEndpoint(warehouse, ListMetricsRequest, ListMetricsResponse, (payload, { runQuery }) =>
		Effect.map(runQuery(Queries.listMetrics, payload), (rows) => new ListMetricsResponse({ data: rows })),
	),
	"queryEngine.metricsSummary": warehouseEndpoint(warehouse, MetricsSummaryRequest, MetricsSummaryResponse, (payload, { runQuery }) =>
		Effect.map(
			runQuery(Queries.metricsSummary, payload),
			(rows) =>
				new MetricsSummaryResponse({
					data: rows.map((row) => ({
						metricType: row.metricType,
						metricCount: row.metricCount,
						dataPointCount: row.dataPointCount,
					})),
				}),
		),
	),
	"queryEngine.infraPresence": warehouseEndpoint(warehouse, InfraPresenceRequest, InfraPresenceResponse, (payload, { runQuery }) =>
		Effect.map(
			runQuery(Queries.infraPresence, payload),
			(rows) => new InfraPresenceResponse({ surfaces: rows.flatMap((row) => (isInfraSurface(row.surface) ? [row.surface] : [])) }),
		),
	),
	"queryEngine.productEventNames": warehouseEndpoint(
		warehouse,
		ProductEventNamesRequest,
		ProductEventNamesResponse,
		(payload, { runQuery }) =>
			Effect.map(
				runQuery(Queries.productEventNames, payload),
				(rows) =>
					new ProductEventNamesResponse({
						data: rows.map((row) => ({
							eventName: row.eventName,
							kind: row.kind,
							count: row.count || 0,
							sessions: row.sessions || 0,
							persons: row.persons || 0,
						})),
					}),
			),
	),
	"queryEngine.executeRawSql": rawSqlEndpoint(warehouse),
})
