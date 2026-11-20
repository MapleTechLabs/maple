import { Effect, Schema } from "effect"
import { PromqlDiscoverRequest, PromqlExecuteRequest, RawSqlDisplayType } from "@maple/domain/http"
import { MAX_PROMQL_LEGEND_LENGTH, MAX_PROMQL_QUERY_LENGTH } from "@maple/primitives"
import { MapleInternalHttp } from "./warehouse-services"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "./effect-utils"

// PromQL chart server function (widget data source `promql_chart`). The API picks the
// step, fills `$__interval` and friends, and shapes the rows for `displayType` the same
// way the share API does, so a board and its share link draw the same series.

const GetPromqlChartInputSchema = Schema.Struct({
	// The request class's own bounds, so a bad input is a typed input error before it is built.
	promql: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_PROMQL_QUERY_LENGTH)),
	startTime: WarehouseDateTimeString,
	endTime: WarehouseDateTimeString,
	legendFormat: Schema.optional(Schema.String.check(Schema.isMaxLength(MAX_PROMQL_LEGEND_LENGTH))),
	minStepSeconds: Schema.optional(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0))),
	maxDataPoints: Schema.optional(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0))),
	// Stored PromQL sources type it as any string; one this host cannot draw falls back to table rows,
	// as `raw-sql-chart.ts` does, instead of failing the whole tile.
	displayType: Schema.optional(Schema.String),
})

export type GetPromqlChartInput = Schema.Schema.Type<typeof GetPromqlChartInputSchema>

export const getPromqlChart = Effect.fn("QueryEngine.getPromqlChart")(function* ({
	data,
}: {
	data: GetPromqlChartInput
}) {
	const input = yield* decodeInput(GetPromqlChartInputSchema, data, "getPromqlChart")
	const displayType = Schema.is(RawSqlDisplayType)(input.displayType) ? input.displayType : undefined

	const result = yield* runWarehouseQuery("promqlChart", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.executePromql({
				payload: new PromqlExecuteRequest({
					query: input.promql,
					startTime: input.startTime,
					endTime: input.endTime,
					...(input.legendFormat === undefined ? undefined : { legendFormat: input.legendFormat }),
					...(input.minStepSeconds === undefined
						? undefined
						: { minStepSeconds: input.minStepSeconds }),
					...(input.maxDataPoints === undefined
						? undefined
						: { maxDataPoints: input.maxDataPoints }),
					...(displayType === undefined ? undefined : { displayType }),
				}),
			})
		}),
	)

	// `warnings` beside `data`, as the share and v2 widget data envelopes carry them.
	const warnings = result.meta.warnings ?? []
	return { data: result.data, meta: result.meta, ...(warnings.length === 0 ? undefined : { warnings }) }
})

/** What the PromQL editor autocompletes from: label names with no `label`, else that label's values. */
export type PromqlDiscoverInput = Readonly<{
	label?: string
	match?: string
	limit?: number
	startTime: string
	endTime: string
}>

export const discoverPromql = Effect.fn("QueryEngine.discoverPromql")(function* (input: PromqlDiscoverInput) {
	const result = yield* runWarehouseQuery("promqlDiscover", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.discoverPromql({
				payload: new PromqlDiscoverRequest({
					startTime: input.startTime,
					endTime: input.endTime,
					...(input.label === undefined ? undefined : { label: input.label }),
					...(input.match === undefined ? undefined : { match: input.match }),
					...(input.limit === undefined ? undefined : { limit: input.limit }),
				}),
			})
		}),
	)
	return result.data
})
