import { Effect, Schema } from "effect"
import { PromqlExecuteRequest, RawSqlDisplayType } from "@maple/domain/http"
import { MapleInternalHttp } from "./warehouse-services"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "./effect-utils"

// PromQL chart server function (widget data source `promql_chart`). The API picks the
// step, fills `$__interval` and friends, and shapes the rows for `displayType` the same
// way the share API does, so a board and its share link draw the same series.

const GetPromqlChartInputSchema = Schema.Struct({
	promql: Schema.String,
	startTime: WarehouseDateTimeString,
	endTime: WarehouseDateTimeString,
	legendFormat: Schema.optional(Schema.String),
	minStepSeconds: Schema.optional(Schema.Number),
	maxDataPoints: Schema.optional(Schema.Number),
	displayType: Schema.optional(RawSqlDisplayType),
})

export type GetPromqlChartInput = Schema.Schema.Type<typeof GetPromqlChartInputSchema>

export const getPromqlChart = Effect.fn("QueryEngine.getPromqlChart")(function* ({
	data,
}: {
	data: GetPromqlChartInput
}) {
	const input = yield* decodeInput(GetPromqlChartInputSchema, data, "getPromqlChart")

	const result = yield* runWarehouseQuery("promqlChart", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.executePromql({
				payload: new PromqlExecuteRequest({
					query: input.promql,
					startTime: input.startTime,
					endTime: input.endTime,
					legendFormat: input.legendFormat,
					minStepSeconds: input.minStepSeconds,
					maxDataPoints: input.maxDataPoints,
					displayType: input.displayType,
				}),
			})
		}),
	)

	return { data: result.data, meta: result.meta }
})
