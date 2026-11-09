// Google Search Console performance for the /analytics Search tab. Each read names one enabled
// property; see packages/query-engine/src/ch/queries/search-console.ts for the grains.

import { Effect } from "effect"
import {
	SearchConsoleLandingPagesRequest,
	SearchConsoleOverviewRequest,
	SearchConsoleTimeseriesRequest,
	SearchConsoleTopPagesRequest,
	SearchConsoleTopQueriesRequest,
} from "@maple/domain/http"
import { MapleInternalHttp } from "./warehouse-services"
import { decodeInput, runWarehouseQuery } from "./effect-utils"

export type GetSearchConsoleOverviewInput = typeof SearchConsoleOverviewRequest.Encoded
export type GetSearchConsoleTimeseriesInput = typeof SearchConsoleTimeseriesRequest.Encoded
export type GetSearchConsoleTopQueriesInput = typeof SearchConsoleTopQueriesRequest.Encoded
export type GetSearchConsoleTopPagesInput = typeof SearchConsoleTopPagesRequest.Encoded
export type GetSearchConsoleLandingPagesInput = typeof SearchConsoleLandingPagesRequest.Encoded

export const getSearchConsoleOverview = Effect.fn("QueryEngine.getSearchConsoleOverview")(function* ({
	data,
}: {
	data: GetSearchConsoleOverviewInput
}) {
	const payload = yield* decodeInput(SearchConsoleOverviewRequest, data, "getSearchConsoleOverview")
	const result = yield* runWarehouseQuery("searchConsoleOverview", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.searchConsoleOverview({ payload })
		}),
	)
	return result.data
})

export const getSearchConsoleTimeseries = Effect.fn("QueryEngine.getSearchConsoleTimeseries")(function* ({
	data,
}: {
	data: GetSearchConsoleTimeseriesInput
}) {
	const payload = yield* decodeInput(SearchConsoleTimeseriesRequest, data, "getSearchConsoleTimeseries")
	const result = yield* runWarehouseQuery("searchConsoleTimeseries", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.searchConsoleTimeseries({ payload })
		}),
	)
	return result.data
})

export const getSearchConsoleTopQueries = Effect.fn("QueryEngine.getSearchConsoleTopQueries")(function* ({
	data,
}: {
	data: GetSearchConsoleTopQueriesInput
}) {
	const payload = yield* decodeInput(SearchConsoleTopQueriesRequest, data, "getSearchConsoleTopQueries")
	const result = yield* runWarehouseQuery("searchConsoleTopQueries", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.searchConsoleTopQueries({ payload })
		}),
	)
	return result.data
})

export const getSearchConsoleTopPages = Effect.fn("QueryEngine.getSearchConsoleTopPages")(function* ({
	data,
}: {
	data: GetSearchConsoleTopPagesInput
}) {
	const payload = yield* decodeInput(SearchConsoleTopPagesRequest, data, "getSearchConsoleTopPages")
	const result = yield* runWarehouseQuery("searchConsoleTopPages", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.searchConsoleTopPages({ payload })
		}),
	)
	return result.data
})

export const getSearchConsoleLandingPages = Effect.fn("QueryEngine.getSearchConsoleLandingPages")(function* ({
	data,
}: {
	data: GetSearchConsoleLandingPagesInput
}) {
	const payload = yield* decodeInput(SearchConsoleLandingPagesRequest, data, "getSearchConsoleLandingPages")
	const result = yield* runWarehouseQuery("searchConsoleLandingPages", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.searchConsoleLandingPages({ payload })
		}),
	)
	return result.data
})
