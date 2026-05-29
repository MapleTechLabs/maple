// The shared operation surface — thin wrappers over @maple/query-engine
// observability functions, parameterised by simple request objects. The CLI
// commands and the HTTP server both call these, so the two transports never
// drift. Every operation returns an Effect requiring `WarehouseExecutor`
// (provided by the local executor layer).

import { Effect } from "effect"
import type { TracesMetric } from "@maple/query-engine"
import {
	WarehouseExecutor,
	listServices as obsListServices,
	searchTraces as obsSearchTraces,
	inspectTrace as obsInspectTrace,
	findErrors as obsFindErrors,
	errorDetail as obsErrorDetail,
	diagnoseService as obsDiagnoseService,
	searchLogs as obsSearchLogs,
	mineLogPatterns as obsMineLogPatterns,
	exploreAttributeKeys as obsAttributeKeys,
	exploreAttributeValues as obsAttributeValues,
	serviceMap as obsServiceMap,
	findSlowTraces as obsFindSlowTraces,
	topOperations as obsTopOperations,
} from "@maple/query-engine/observability"
import type { Range } from "./time"

type AttrSource = "traces" | "metrics" | "services"
type AttrScope = "span" | "resource"

export const listServices = (p: { range: Range; environment?: string }) =>
	obsListServices({ timeRange: p.range, environment: p.environment })

export const searchTraces = (p: {
	range: Range
	service?: string
	spanName?: string
	hasError?: boolean
	minDurationMs?: number
	maxDurationMs?: number
	httpMethod?: string
	traceId?: string
	rootOnly?: boolean
	limit?: number
	offset?: number
}) =>
	obsSearchTraces({
		timeRange: p.range,
		service: p.service,
		spanName: p.spanName,
		spanNameMatchMode: p.spanName ? "contains" : undefined,
		hasError: p.hasError,
		minDurationMs: p.minDurationMs,
		maxDurationMs: p.maxDurationMs,
		httpMethod: p.httpMethod,
		traceId: p.traceId,
		rootOnly: p.rootOnly,
		limit: p.limit,
		offset: p.offset,
	})

export const inspectTrace = (p: { traceId: string }) => obsInspectTrace(p.traceId)

export const findErrors = (p: {
	range: Range
	service?: string
	environment?: string
	limit?: number
}) => obsFindErrors({ timeRange: p.range, service: p.service, environment: p.environment, limit: p.limit })

export const errorDetail = (p: {
	fingerprintHash: string
	range: Range
	service?: string
	limit?: number
}) =>
	obsErrorDetail({
		fingerprintHash: p.fingerprintHash,
		timeRange: p.range,
		service: p.service,
		includeTimeseries: true,
		limit: p.limit,
	})

export const diagnoseService = (p: { serviceName: string; range: Range; environment?: string }) =>
	obsDiagnoseService({ serviceName: p.serviceName, timeRange: p.range, environment: p.environment })

export const searchLogs = (p: {
	range: Range
	service?: string
	severity?: string
	search?: string
	traceId?: string
	limit?: number
	offset?: number
}) =>
	obsSearchLogs({
		timeRange: p.range,
		service: p.service,
		severity: p.severity,
		search: p.search,
		traceId: p.traceId,
		limit: p.limit,
		offset: p.offset,
	})

export const mineLogPatterns = (p: {
	range: Range
	service?: string
	severity?: string
	search?: string
	limit?: number
}) =>
	obsMineLogPatterns({
		timeRange: p.range,
		service: p.service,
		severity: p.severity,
		search: p.search,
		limit: p.limit,
	})

export const findSlowTraces = (p: {
	range: Range
	service?: string
	environment?: string
	limit?: number
}) =>
	obsFindSlowTraces({ timeRange: p.range, service: p.service, environment: p.environment, limit: p.limit })

export const serviceMap = (p: { range: Range; service?: string; environment?: string }) =>
	obsServiceMap({ timeRange: p.range, service: p.service, environment: p.environment })

export const attributeKeys = (p: {
	source: AttrSource
	scope?: AttrScope
	service?: string
	range: Range
	limit?: number
}) =>
	obsAttributeKeys({
		source: p.source,
		scope: p.scope,
		service: p.service,
		timeRange: p.range,
		limit: p.limit,
	})

export const attributeValues = (p: {
	key: string
	source: AttrSource
	scope?: AttrScope
	service?: string
	range: Range
	limit?: number
}) =>
	obsAttributeValues({
		source: p.source,
		scope: p.scope,
		key: p.key,
		service: p.service,
		timeRange: p.range,
		limit: p.limit,
	})

export const topOperations = (p: {
	serviceName: string
	metric: TracesMetric
	range: Range
	limit?: number
}) => obsTopOperations({ serviceName: p.serviceName, metric: p.metric, timeRange: p.range, limit: p.limit })

export const listMetrics = (p: { range: Range; service?: string; search?: string; limit?: number }) =>
	Effect.gen(function* () {
		const executor = yield* WarehouseExecutor
		const result = yield* executor.query("list_metrics", {
			start_time: p.range.startTime,
			end_time: p.range.endTime,
			...(p.service ? { service: p.service } : {}),
			...(p.search ? { search: p.search } : {}),
			limit: p.limit ?? 100,
		})
		return result.data
	})

/** Raw SQL escape hatch against the local chDB store. */
export const rawQuery = (sql: string) =>
	Effect.gen(function* () {
		const executor = yield* WarehouseExecutor
		return yield* executor.sqlQuery(sql)
	})
