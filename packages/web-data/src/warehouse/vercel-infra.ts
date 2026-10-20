import { Clock, Effect, Schema } from "effect"
import {
	VercelInfraProjectDetailRequest,
	VercelInfraProjectsRequest,
	VercelInfraTimeseriesRequest,
} from "@maple/domain/http"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { MapleInternalHttp } from "./warehouse-services"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "./effect-utils"

/** /infra/vercel data access over the Vercel drains' logs and traces. */

const TimeRangeInputSchema = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
})

const TimeseriesInputSchema = Schema.Struct({
	...TimeRangeInputSchema.fields,
	bucketSeconds: Schema.Number,
	projectId: Schema.optional(Schema.String),
})

const ProjectInputSchema = Schema.Struct({
	...TimeRangeInputSchema.fields,
	projectId: Schema.String,
})

export type VercelTimeRangeInput = (typeof TimeRangeInputSchema)["Encoded"]
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
	const range = resolveRange(input, yield* Clock.currentTimeMillis)
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
	const window = { ...resolveRange(input, nowMillis), bucketSeconds: input.bucketSeconds }
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
	const payload = timeseriesRequest(input, yield* Clock.currentTimeMillis)
	return yield* runWarehouseQuery("vercelInfraRequestTimeseries", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.vercelInfraRequestTimeseries({ payload })
		}),
	)
})

export const getVercelProjectDetail = Effect.fn("QueryEngine.getVercelProjectDetail")(function* ({
	data,
}: {
	data: VercelProjectInput
}) {
	const input = yield* decodeInput(ProjectInputSchema, data, "getVercelProjectDetail")
	const range = resolveRange(input, yield* Clock.currentTimeMillis)
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
	const payload = timeseriesRequest(input, yield* Clock.currentTimeMillis)
	return yield* runWarehouseQuery("vercelAiGateway", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.vercelAiGateway({ payload })
		}),
	)
})
