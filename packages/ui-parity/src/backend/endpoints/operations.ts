import { DateTime, Effect } from "effect"
import {
	ServiceEndpointsRequest,
	ServiceEndpointsResponse,
	ServiceOperationsRequest,
	ServiceOperationsResponse,
} from "@maple/domain/http"
import { CH, parseWarehouseDateTime } from "@maple/query-engine"
import { Queries, type QueryDefinition } from "@maple/query-engine/registry"
import type { EndpointHandler } from "../../fixtures/dataset.ts"
import type { FixtureWarehouse } from "../warehouse.ts"
import { warehouseEndpoint, type WarehouseContext } from "./run.ts"

/**
 * `operationRowsWithSparklines` from the API handler: summary rows from the operations rollup,
 * plus one sparkline per row on whole-minute buckets (~50 points) when asked. The fixture
 * warehouse always has the rollup, so the raw-traces fallback never applies.
 */
const operationRows = (
	{ runQuery }: WarehouseContext,
	payload: ServiceOperationsRequest | ServiceEndpointsRequest,
	summary: QueryDefinition<ServiceOperationsRequest, CH.ServiceOperationsSummaryOutput>,
	sparklines: boolean,
) =>
	Effect.gen(function* () {
		const toNumber = (value: unknown) => Number(value ?? 0)
		const summaryRows = yield* runQuery(summary, payload)
		if (summaryRows.length === 0) return []
		const toRow = (row: CH.ServiceOperationsSummaryOutput, sparkline: ReadonlyArray<{ bucket: string; count: number }>) => ({
			spanName: row.spanName,
			spanCount: toNumber(row.spanCount),
			estimatedSpanCount: toNumber(row.estimatedSpanCount),
			errorCount: toNumber(row.errorCount),
			estimatedErrorCount: toNumber(row.estimatedErrorCount),
			errorRate: toNumber(row.errorRate),
			avgDurationMs: toNumber(row.avgDurationMs),
			p50DurationMs: toNumber(row.p50DurationMs),
			p95DurationMs: toNumber(row.p95DurationMs),
			p99DurationMs: toNumber(row.p99DurationMs),
			sparkline: [...sparkline],
		})
		if (!sparklines) return summaryRows.map((row) => toRow(row, []))
		const windowSeconds = Math.max(
			0,
			(parseWarehouseDateTime(payload.endTime) - parseWarehouseDateTime(payload.startTime)) / 1000,
		)
		const requested = ("bucketSeconds" in payload ? payload.bucketSeconds : undefined) ?? windowSeconds / 50
		const bucketSeconds = Math.max(1, Math.round(requested / 60)) * 60
		const spanNames = summaryRows.map((row) => row.spanName)
		const timeseriesRows = yield* runQuery(Queries.serviceOperationsTimeseries, { ...payload, spanNames, bucketSeconds })
		const points = (spanName: string) =>
			timeseriesRows
				.filter((row) => row.spanName === spanName)
				.map((row) => ({ bucket: DateTime.formatIso(row.bucket), count: toNumber(row.count) }))
		return summaryRows.map((row) => toRow(row, points(row.spanName)))
	})

export const operationEndpoints = (warehouse: FixtureWarehouse): Readonly<Record<string, EndpointHandler>> => ({
	"queryEngine.serviceOperations": warehouseEndpoint(
		warehouse,
		ServiceOperationsRequest,
		ServiceOperationsResponse,
		(payload, context) =>
			Effect.map(
				operationRows(context, payload, Queries.serviceOperationsSummary, true),
				(data) => new ServiceOperationsResponse({ data }),
			),
	),
	"queryEngine.serviceEndpoints": warehouseEndpoint(
		warehouse,
		ServiceEndpointsRequest,
		ServiceEndpointsResponse,
		(payload, context) =>
			Effect.map(
				operationRows(context, payload, Queries.serviceEndpointsSummary, false),
				(rows) => new ServiceEndpointsResponse({ data: rows.map((row) => ({ ...row, ...CH.splitEndpointName(row.spanName) })) }),
			),
	),
})
