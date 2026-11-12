// Cloud cost for the /cost page: provider spend per whole UTC day, and each cost source's sync
// state. See packages/backend/src/queries/cost-reads.ts for the shapes an org without a source gets.

import { Effect } from "effect"
import { CostBreakdownRequest, CostTimeseriesRequest, CostTotalsRequest } from "@maple/domain/http"
import { MapleInternalHttp } from "./warehouse-services"
import { decodeInput, runWarehouseQuery } from "./effect-utils"

export type GetCostTotalsInput = typeof CostTotalsRequest.Encoded
export type GetCostTimeseriesInput = typeof CostTimeseriesRequest.Encoded
export type GetCostBreakdownInput = typeof CostBreakdownRequest.Encoded

export const getCostTotals = Effect.fn("QueryEngine.getCostTotals")(function* ({
	data,
}: {
	data: GetCostTotalsInput
}) {
	const payload = yield* decodeInput(CostTotalsRequest, data, "getCostTotals")
	return yield* runWarehouseQuery("costTotals", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.costTotals({ payload })
		}),
	)
})

export const getCostTimeseries = Effect.fn("QueryEngine.getCostTimeseries")(function* ({
	data,
}: {
	data: GetCostTimeseriesInput
}) {
	const payload = yield* decodeInput(CostTimeseriesRequest, data, "getCostTimeseries")
	return yield* runWarehouseQuery("costTimeseries", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.costTimeseries({ payload })
		}),
	)
})

export const getCostBreakdown = Effect.fn("QueryEngine.getCostBreakdown")(function* ({
	data,
}: {
	data: GetCostBreakdownInput
}) {
	const payload = yield* decodeInput(CostBreakdownRequest, data, "getCostBreakdown")
	return yield* runWarehouseQuery("costBreakdown", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.costBreakdown({ payload })
		}),
	)
})

/** Every cost source of the org and how far its sync is; no window. */
export const getCostSources = Effect.fn("QueryEngine.getCostSources")(function* () {
	return yield* runWarehouseQuery("costSources", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.costSources()
		}),
	)
})
