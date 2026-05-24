import { Effect, Schema } from "effect"
import { QueryEngineExecuteRequest, warehouseDateTimeToIso } from "@maple/query-engine"
import {
	ErrorsByTypeRequest,
	ErrorsSummaryRequest,
	ErrorDetailTracesRequest,
	ErrorsTimeseriesRequest,
} from "@maple/domain/http"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import {
	WarehouseDateTimeString,
	decodeInput,
	executeQueryEngine,
	extractFacets,
	runWarehouseQuery,
} from "@/api/warehouse/effect-utils"

const OptionalStringArray = Schema.optional(Schema.mutable(Schema.Array(Schema.String)))

export interface ErrorByType {
	fingerprintHash: string
	errorLabel: string
	sampleMessage: string
	count: number
	affectedServicesCount: number
	firstSeen: Date
	lastSeen: Date
}

export interface ErrorsByTypeResponse {
	data: ErrorByType[]
}

const GetErrorsByTypeInputSchema = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	services: OptionalStringArray,
	deploymentEnvs: OptionalStringArray,
	fingerprintHashes: OptionalStringArray,
	limit: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
	showSpam: Schema.optional(Schema.Boolean),
	rootOnly: Schema.optional(Schema.Boolean),
})

export type GetErrorsByTypeInput = Schema.Schema.Type<typeof GetErrorsByTypeInputSchema>

export function getErrorsByType({ data }: { data: GetErrorsByTypeInput }) {
	return getErrorsByTypeEffect({ data })
}

const getErrorsByTypeEffect = Effect.fn("QueryEngine.getErrorsByType")(function* ({
	data,
}: {
	data: GetErrorsByTypeInput
}) {
	const input = yield* decodeInput(GetErrorsByTypeInputSchema, data ?? {}, "getErrorsByType")
	const fallback = defaultErrorsTimeRange()

	const result = yield* runWarehouseQuery("errorsByType", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.errorsByType({
				payload: new ErrorsByTypeRequest({
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
					rootOnly: input.rootOnly,
					services: input.services,
					deploymentEnvs: input.deploymentEnvs,
					fingerprintHashes: input.fingerprintHashes,
					limit: input.limit,
				}),
			})
		}),
	)

	return {
		data: result.data.map((raw) => ({
			fingerprintHash: raw.fingerprintHash,
			errorLabel: raw.errorLabel,
			sampleMessage: raw.sampleMessage,
			count: Number(raw.count),
			affectedServicesCount: Number(raw.affectedServicesCount),
			firstSeen: new Date(warehouseDateTimeToIso(raw.firstSeen)),
			lastSeen: new Date(warehouseDateTimeToIso(raw.lastSeen)),
		})),
	}
})

export interface FacetItem {
	name: string
	count: number
}

export interface ErrorsFacets {
	services: FacetItem[]
	deploymentEnvs: FacetItem[]
	errorTypes: FacetItem[]
}

export interface ErrorsFacetsResponse {
	data: ErrorsFacets
}

const GetErrorsFacetsInputSchema = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	services: OptionalStringArray,
	deploymentEnvs: OptionalStringArray,
	fingerprintHashes: OptionalStringArray,
	showSpam: Schema.optional(Schema.Boolean),
	rootOnly: Schema.optional(Schema.Boolean),
})

export type GetErrorsFacetsInput = Schema.Schema.Type<typeof GetErrorsFacetsInputSchema>

const defaultErrorsTimeRange = () => {
	const now = new Date()
	const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
	const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19)
	return { startTime: fmt(dayAgo), endTime: fmt(now) }
}

export function getErrorsFacets({ data }: { data: GetErrorsFacetsInput }) {
	return getErrorsFacetsEffect({ data })
}

const getErrorsFacetsEffect = Effect.fn("QueryEngine.getErrorsFacets")(function* ({
	data,
}: {
	data: GetErrorsFacetsInput
}) {
	const input = yield* decodeInput(GetErrorsFacetsInputSchema, data ?? {}, "getErrorsFacets")
	const fallback = defaultErrorsTimeRange()

	const response = yield* executeQueryEngine(
		"queryEngine.getErrorsFacets",
		new QueryEngineExecuteRequest({
			startTime: input.startTime ?? fallback.startTime,
			endTime: input.endTime ?? fallback.endTime,
			query: {
				kind: "facets" as const,
				source: "errors" as const,
				filters: {
					rootOnly: input.rootOnly,
					services: input.services,
					deploymentEnvs: input.deploymentEnvs,
					fingerprintHashes: input.fingerprintHashes,
				},
			},
		}),
	)

	const facetsData = extractFacets(response)
	const services: FacetItem[] = []
	const deploymentEnvs: FacetItem[] = []
	const errorTypes: FacetItem[] = []

	for (const row of facetsData) {
		const item = { name: row.name, count: Number(row.count) }
		switch (row.facetType) {
			case "service":
				services.push(item)
				break
			case "deploymentEnv":
				deploymentEnvs.push(item)
				break
			case "errorType":
				errorTypes.push(item)
				break
		}
	}

	return {
		data: { services, deploymentEnvs, errorTypes },
	}
})

export interface ErrorsSummary {
	totalErrors: number
	totalSpans: number
	errorRate: number
	affectedServicesCount: number
	affectedTracesCount: number
}

export interface ErrorsSummaryResponse {
	data: ErrorsSummary | null
}

const GetErrorsSummaryInputSchema = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	services: OptionalStringArray,
	deploymentEnvs: OptionalStringArray,
	fingerprintHashes: OptionalStringArray,
	showSpam: Schema.optional(Schema.Boolean),
	rootOnly: Schema.optional(Schema.Boolean),
})

export type GetErrorsSummaryInput = Schema.Schema.Type<typeof GetErrorsSummaryInputSchema>

export function getErrorsSummary({ data }: { data: GetErrorsSummaryInput }) {
	return getErrorsSummaryEffect({ data })
}

const getErrorsSummaryEffect = Effect.fn("QueryEngine.getErrorsSummary")(function* ({
	data,
}: {
	data: GetErrorsSummaryInput
}) {
	const input = yield* decodeInput(GetErrorsSummaryInputSchema, data ?? {}, "getErrorsSummary")
	const fallback = defaultErrorsTimeRange()

	const result = yield* runWarehouseQuery("errorsSummary", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.errorsSummary({
				payload: new ErrorsSummaryRequest({
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
					rootOnly: input.rootOnly,
					services: input.services,
					deploymentEnvs: input.deploymentEnvs,
					fingerprintHashes: input.fingerprintHashes,
				}),
			})
		}),
	)

	const summary = result.data
	return {
		data: summary
			? {
					totalErrors: Number(summary.totalErrors),
					totalSpans: Number(summary.totalSpans),
					errorRate: Number(summary.errorRate),
					affectedServicesCount: Number(summary.affectedServicesCount),
					affectedTracesCount: Number(summary.affectedTracesCount),
				}
			: null,
	}
})

export interface ErrorDetailTrace {
	traceId: string
	startTime: Date
	durationMicros: number
	spanCount: number
	services: string[]
	rootSpanName: string
	errorMessage: string
}

export interface ErrorDetailTracesResponse {
	data: ErrorDetailTrace[]
}

const GetErrorDetailTracesInputSchema = Schema.Struct({
	fingerprintHash: Schema.String,
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	services: OptionalStringArray,
	limit: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
	showSpam: Schema.optional(Schema.Boolean),
	rootOnly: Schema.optional(Schema.Boolean),
})

export type GetErrorDetailTracesInput = Schema.Schema.Type<typeof GetErrorDetailTracesInputSchema>

export function getErrorDetailTraces({ data }: { data: GetErrorDetailTracesInput }) {
	return getErrorDetailTracesEffect({ data })
}

const getErrorDetailTracesEffect = Effect.fn("QueryEngine.getErrorDetailTraces")(function* ({
	data,
}: {
	data: GetErrorDetailTracesInput
}) {
	const input = yield* decodeInput(GetErrorDetailTracesInputSchema, data ?? {}, "getErrorDetailTraces")
	const fallback = defaultErrorsTimeRange()

	const result = yield* runWarehouseQuery("errorDetailTraces", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.errorDetailTraces({
				payload: new ErrorDetailTracesRequest({
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
					fingerprintHash: input.fingerprintHash,
					rootOnly: input.rootOnly,
					services: input.services,
					limit: input.limit,
				}),
			})
		}),
	)

	return {
		data: result.data.map((raw) => ({
			traceId: raw.traceId,
			startTime: new Date(warehouseDateTimeToIso(raw.startTime)),
			durationMicros: Number(raw.durationMicros),
			spanCount: Number(raw.spanCount),
			services: [...raw.services],
			rootSpanName: raw.rootSpanName,
			errorMessage: raw.errorMessage,
		})),
	}
})

export interface ErrorsTimeseriesItem {
	bucket: string
	count: number
}

const GetErrorsTimeseriesInputSchema = Schema.Struct({
	fingerprintHash: Schema.String,
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	services: OptionalStringArray,
	bucketSeconds: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
	showSpam: Schema.optional(Schema.Boolean),
})

export type GetErrorsTimeseriesInput = Schema.Schema.Type<typeof GetErrorsTimeseriesInputSchema>

export function getErrorsTimeseries({ data }: { data: GetErrorsTimeseriesInput }) {
	return getErrorsTimeseriesEffect({ data })
}

const getErrorsTimeseriesEffect = Effect.fn("QueryEngine.getErrorsTimeseries")(function* ({
	data,
}: {
	data: GetErrorsTimeseriesInput
}) {
	const input = yield* decodeInput(GetErrorsTimeseriesInputSchema, data ?? {}, "getErrorsTimeseries")
	const fallback = defaultErrorsTimeRange()

	const result = yield* runWarehouseQuery("errorsTimeseries", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.errorsTimeseries({
				payload: new ErrorsTimeseriesRequest({
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
					fingerprintHash: input.fingerprintHash,
					services: input.services,
					bucketSeconds: input.bucketSeconds,
				}),
			})
		}),
	)

	return {
		data: result.data.map((raw) => ({
			bucket: String(raw.bucket),
			count: Number(raw.count),
		})),
	}
})
