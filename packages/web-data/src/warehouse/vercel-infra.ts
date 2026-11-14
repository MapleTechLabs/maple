import { Clock, Effect, Schema } from "effect"
import {
	VercelInfraBreakdownDimension,
	VercelInfraBreakdownRequest,
	VercelInfraBreakdownStatus,
	VercelInfraFunctionTimeseriesRequest,
	VercelInfraProjectDetailRequest,
	VercelInfraProjectsRequest,
	VercelInfraTimeseriesRequest,
	VercelInfraWindowRequest,
	VercelRealUsersDimension,
} from "@maple/domain/http"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { MapleInternalHttp } from "./warehouse-services"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "./effect-utils"

/** /infra/vercel data access over the Vercel drains' logs and traces. */

const TimeRangeInputSchema = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
})

/** A request filter: one breakdown dimension and its value. */
const FilterFields = {
	filterBy: Schema.optional(VercelInfraBreakdownDimension),
	filterValue: Schema.optional(Schema.String),
}

const TimeseriesInputSchema = Schema.Struct({
	...TimeRangeInputSchema.fields,
	bucketSeconds: Schema.Number,
	projectId: Schema.optional(Schema.String),
	...FilterFields,
})

/** `{ [key]: value }`, or no key at all: the request schemas reject an explicit `undefined`. */
const present = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> => {
	const field: Partial<Record<K, V>> = {}
	if (value !== undefined) field[key] = value
	return field
}

/** The filter's two fields, or none: the request schemas take neither key when there is no filter. */
const filterOf = (input: {
	readonly filterBy?: VercelInfraBreakdownDimension
	readonly filterValue?: string
}) =>
	input.filterBy === undefined || input.filterValue === undefined
		? {}
		: { filterBy: input.filterBy, filterValue: input.filterValue }

const ProjectInputSchema = Schema.Struct({
	...TimeRangeInputSchema.fields,
	projectId: Schema.String,
})

const WindowInputSchema = Schema.Struct({
	...TimeRangeInputSchema.fields,
	projectId: Schema.optional(Schema.String),
	/** A Real users filter: a route or device (Speed Insights), a page, referrer or country (Web Analytics). */
	filterBy: Schema.optional(VercelRealUsersDimension),
	filterValue: Schema.optional(Schema.String),
})

const BreakdownInputSchema = Schema.Struct({
	...ProjectInputSchema.fields,
	dimension: VercelInfraBreakdownDimension,
	status: Schema.optional(VercelInfraBreakdownStatus),
	...FilterFields,
})

const FunctionTimeseriesInputSchema = Schema.Struct({
	...ProjectInputSchema.fields,
	bucketSeconds: Schema.Number,
	route: Schema.optional(Schema.String),
	host: Schema.optional(Schema.String),
})

export type VercelFunctionTimeseriesInput = (typeof FunctionTimeseriesInputSchema)["Encoded"]
export type VercelBreakdownInput = (typeof BreakdownInputSchema)["Encoded"]
export type VercelTimeRangeInput = (typeof TimeRangeInputSchema)["Encoded"]
export type VercelWindowInput = (typeof WindowInputSchema)["Encoded"]
export type VercelTimeseriesInput = (typeof TimeseriesInputSchema)["Encoded"]
export type VercelProjectInput = (typeof ProjectInputSchema)["Encoded"]

const resolveRange = (input: { startTime?: string; endTime?: string }, nowMillis: number) => ({
	startTime: input.startTime ?? formatWarehouseDateTime(nowMillis - 24 * 60 * 60 * 1000),
	endTime: input.endTime ?? formatWarehouseDateTime(nowMillis),
})

export const getVercelProjects = Effect.fn("QueryEngine.getVercelProjects")(function* ({
	data,
}: {
	data: VercelTimeRangeInput
}) {
	const input = yield* decodeInput(TimeRangeInputSchema, data, "getVercelProjects")
	const nowMillis = yield* Clock.currentTimeMillis
	const range = resolveRange(input, nowMillis)
	return yield* runWarehouseQuery("vercelInfraProjects", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.vercelInfraProjects({
				payload: new VercelInfraProjectsRequest(range),
			})
		}),
	)
})

const timeseriesRequest = (input: (typeof TimeseriesInputSchema)["Type"], nowMillis: number) => {
	const window = {
		...resolveRange(input, nowMillis),
		bucketSeconds: input.bucketSeconds,
		...filterOf(input),
	}
	return input.projectId === undefined
		? new VercelInfraTimeseriesRequest(window)
		: new VercelInfraTimeseriesRequest({ ...window, projectId: input.projectId })
}

export const getVercelRequestTimeseries = Effect.fn("QueryEngine.getVercelRequestTimeseries")(function* ({
	data,
}: {
	data: VercelTimeseriesInput
}) {
	const input = yield* decodeInput(TimeseriesInputSchema, data, "getVercelRequestTimeseries")
	const nowMillis = yield* Clock.currentTimeMillis
	const payload = timeseriesRequest(input, nowMillis)
	return yield* runWarehouseQuery("vercelInfraRequestTimeseries", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.vercelInfraRequestTimeseries({ payload })
		}),
	)
})

/** Edge latency, invocations and cold starts per bucket, from the trace drain. */
export const getVercelLatencyTimeseries = Effect.fn("QueryEngine.getVercelLatencyTimeseries")(function* ({
	data,
}: {
	data: VercelTimeseriesInput
}) {
	const input = yield* decodeInput(TimeseriesInputSchema, data, "getVercelLatencyTimeseries")
	const nowMillis = yield* Clock.currentTimeMillis
	const payload = timeseriesRequest(input, nowMillis)
	return yield* runWarehouseQuery("vercelInfraLatencyTimeseries", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.vercelInfraLatencyTimeseries({ payload })
		}),
	)
})

/** One project's requests grouped by one log attribute. */
export const getVercelBreakdown = Effect.fn("QueryEngine.getVercelBreakdown")(function* ({
	data,
}: {
	data: VercelBreakdownInput
}) {
	const input = yield* decodeInput(BreakdownInputSchema, data, "getVercelBreakdown")
	const nowMillis = yield* Clock.currentTimeMillis
	const range = resolveRange(input, nowMillis)
	return yield* runWarehouseQuery("vercelInfraBreakdown", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.vercelInfraBreakdown({
				payload: new VercelInfraBreakdownRequest({
					...range,
					projectId: input.projectId,
					dimension: input.dimension,
					...present("status", input.status),
					...filterOf(input),
				}),
			})
		}),
	)
})

export const getVercelProjectDetail = Effect.fn("QueryEngine.getVercelProjectDetail")(function* ({
	data,
}: {
	data: VercelProjectInput
}) {
	const input = yield* decodeInput(ProjectInputSchema, data, "getVercelProjectDetail")
	const nowMillis = yield* Clock.currentTimeMillis
	const range = resolveRange(input, nowMillis)
	return yield* runWarehouseQuery("vercelInfraProjectDetail", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.vercelInfraProjectDetail({
				payload: new VercelInfraProjectDetailRequest({ ...range, projectId: input.projectId }),
			})
		}),
	)
})

export const getVercelAiGateway = Effect.fn("QueryEngine.getVercelAiGateway")(function* ({
	data,
}: {
	data: VercelTimeseriesInput
}) {
	const input = yield* decodeInput(TimeseriesInputSchema, data, "getVercelAiGateway")
	const nowMillis = yield* Clock.currentTimeMillis
	const payload = timeseriesRequest(input, nowMillis)
	return yield* runWarehouseQuery("vercelAiGateway", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.vercelAiGateway({ payload })
		}),
	)
})

const windowRequest = (input: (typeof WindowInputSchema)["Type"], nowMillis: number) => {
	const range = resolveRange(input, nowMillis)
	const filter =
		input.filterBy === undefined || input.filterValue === undefined
			? {}
			: { filterBy: input.filterBy, filterValue: input.filterValue }
	return new VercelInfraWindowRequest({ ...range, ...present("projectId", input.projectId), ...filter })
}

export const getVercelFunctions = Effect.fn("QueryEngine.getVercelFunctions")(function* ({
	data,
}: {
	data: VercelProjectInput
}) {
	const input = yield* decodeInput(ProjectInputSchema, data, "getVercelFunctions")
	const nowMillis = yield* Clock.currentTimeMillis
	const range = resolveRange(input, nowMillis)
	return yield* runWarehouseQuery("vercelInfraFunctions", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.vercelInfraFunctions({
				payload: new VercelInfraProjectDetailRequest({ ...range, projectId: input.projectId }),
			})
		}),
	)
})

export const getVercelDependencies = Effect.fn("QueryEngine.getVercelDependencies")(function* ({
	data,
}: {
	data: VercelProjectInput
}) {
	const input = yield* decodeInput(ProjectInputSchema, data, "getVercelDependencies")
	const nowMillis = yield* Clock.currentTimeMillis
	const range = resolveRange(input, nowMillis)
	return yield* runWarehouseQuery("vercelInfraDependencies", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.vercelInfraDependencies({
				payload: new VercelInfraProjectDetailRequest({ ...range, projectId: input.projectId }),
			})
		}),
	)
})

export const getVercelSpeedInsights = Effect.fn("QueryEngine.getVercelSpeedInsights")(function* ({
	data,
}: {
	data: VercelWindowInput
}) {
	const input = yield* decodeInput(WindowInputSchema, data, "getVercelSpeedInsights")
	const nowMillis = yield* Clock.currentTimeMillis
	const payload = windowRequest(input, nowMillis)
	return yield* runWarehouseQuery("vercelSpeedInsights", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.vercelSpeedInsights({ payload })
		}),
	)
})

export const getVercelWebAnalytics = Effect.fn("QueryEngine.getVercelWebAnalytics")(function* ({
	data,
}: {
	data: VercelWindowInput
}) {
	const input = yield* decodeInput(WindowInputSchema, data, "getVercelWebAnalytics")
	const nowMillis = yield* Clock.currentTimeMillis
	const payload = windowRequest(input, nowMillis)
	return yield* runWarehouseQuery("vercelWebAnalytics", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.vercelWebAnalytics({ payload })
		}),
	)
})

/** One project's functions per bucket, for every route or one. */
export const getVercelFunctionTimeseries = Effect.fn("QueryEngine.getVercelFunctionTimeseries")(function* ({
	data,
}: {
	data: VercelFunctionTimeseriesInput
}) {
	const input = yield* decodeInput(FunctionTimeseriesInputSchema, data, "getVercelFunctionTimeseries")
	const nowMillis = yield* Clock.currentTimeMillis
	const window = {
		...resolveRange(input, nowMillis),
		bucketSeconds: input.bucketSeconds,
		projectId: input.projectId,
	}
	return yield* runWarehouseQuery("vercelInfraFunctionTimeseries", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.vercelInfraFunctionTimeseries({
				payload: new VercelInfraFunctionTimeseriesRequest({
					...window,
					...present("route", input.route),
					...present("host", input.host),
				}),
			})
		}),
	)
})
