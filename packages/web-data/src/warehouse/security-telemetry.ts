// The Security Center's telemetry tabs: scanner probes (`securityExposure`) and the runtimes each
// service reports with their release cycles (`securityRuntimes`).

import { Effect, Schema } from "effect"
import {
	SecurityExposureRequest,
	type SecurityExposureResponse,
	SecurityRuntimesRequest,
	type SecurityRuntimesResponse,
} from "@maple/domain/http"
import { MapleInternalHttp } from "./warehouse-services"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "./effect-utils"

const TimeWindowFields = { startTime: WarehouseDateTimeString, endTime: WarehouseDateTimeString } as const
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

const SecurityExposureInputSchema = Schema.Struct({
	...TimeWindowFields,
	bucketSeconds: Schema.optional(PositiveInt),
})

const SecurityRuntimesInputSchema = Schema.Struct({ ...TimeWindowFields })

export type GetSecurityExposureInput = (typeof SecurityExposureInputSchema)["Encoded"]
export type GetSecurityRuntimesInput = (typeof SecurityRuntimesInputSchema)["Encoded"]

export type SecurityExposure = SecurityExposureResponse["data"]
export type SecurityRuntimes = SecurityRuntimesResponse["data"]

export function getSecurityExposure({ data }: { data: GetSecurityExposureInput }) {
	return getSecurityExposureEffect({ data })
}

const getSecurityExposureEffect = Effect.fn("QueryEngine.getSecurityExposure")(function* ({
	data,
}: {
	data: GetSecurityExposureInput
}) {
	const input = yield* decodeInput(SecurityExposureInputSchema, data, "getSecurityExposure")

	const result = yield* runWarehouseQuery("securityExposure", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.securityExposure({
				payload: new SecurityExposureRequest(input),
			})
		}),
	)

	return result.data satisfies SecurityExposure
})

export function getSecurityRuntimes({ data }: { data: GetSecurityRuntimesInput }) {
	return getSecurityRuntimesEffect({ data })
}

const getSecurityRuntimesEffect = Effect.fn("QueryEngine.getSecurityRuntimes")(function* ({
	data,
}: {
	data: GetSecurityRuntimesInput
}) {
	const input = yield* decodeInput(SecurityRuntimesInputSchema, data, "getSecurityRuntimes")

	const result = yield* runWarehouseQuery("securityRuntimes", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.securityRuntimes({
				payload: new SecurityRuntimesRequest(input),
			})
		}),
	)

	return result.data satisfies SecurityRuntimes
})
