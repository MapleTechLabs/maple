import { Clock, Effect, Schema } from "effect"
import { ErrorRateByServiceRequest } from "@maple/domain/http"
import { MapleInternalHttp } from "./warehouse-services"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "./effect-utils"

import { formatWarehouseDateTime } from "@maple/query-engine"
const GetErrorRateByServiceInput = Schema.Struct({
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
})

export type GetErrorRateByServiceInput = Schema.Schema.Type<typeof GetErrorRateByServiceInput>

const defaultTimeRange = (nowMillis: number) => {
	return {
		startTime: formatWarehouseDateTime(nowMillis - 24 * 60 * 60 * 1000),
		endTime: formatWarehouseDateTime(nowMillis),
	}
}

export const getErrorRateByService = Effect.fn("QueryEngine.getErrorRateByService")(function* ({
	data,
}: {
	data: GetErrorRateByServiceInput
}) {
	const input = yield* decodeInput(GetErrorRateByServiceInput, data ?? {}, "getErrorRateByService")

	const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)
	const result = yield* runWarehouseQuery("errorRateByService", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.errorRateByService({
				payload: new ErrorRateByServiceRequest({
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
				}),
			})
		}),
	)

	return {
		data: result.data.map((row) => ({
			serviceName: row.serviceName,
			totalLogs: row.totalLogs,
			errorLogs: row.errorLogs,
			errorRate: row.errorRate,
		})),
	}
})
