import { describe, expect, it } from "@effect/vitest"
import { MapleInternalApi } from "@maple/domain/http"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { getPromqlChart } from "./promql-chart"
import { MapleInternalHttp, WarehouseExecutor } from "./warehouse-services"

const rows = [{ bucket: "2026-11-16 10:00:00", series: "up", value: 1 }]

/** The API stub answers every PromQL execute and keeps each request body it was sent. */
const recordingApi = () => {
	const sent: Array<unknown> = []
	const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		sent.push(await new Request(input, init).json())
		return Response.json({
			data: rows,
			meta: { resultType: "matrix", seriesCount: 1, stepSeconds: 60 },
		})
	}
	const layer = Layer.mergeAll(
		Layer.mock(WarehouseExecutor, {}),
		Layer.effect(
			MapleInternalHttp,
			HttpApiClient.make(MapleInternalApi, { baseUrl: "https://api.test" }),
		).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
	)
	return { sent, layer }
}

const window = { startTime: "2026-11-16 10:00:00", endTime: "2026-11-16 11:00:00" }

describe("getPromqlChart", () => {
	it.effect("draws a widget whose stored display type this build does not know, as table rows", () => {
		const api = recordingApi()
		return Effect.gen(function* () {
			const result = yield* getPromqlChart({ data: { promql: "up", displayType: "timeseries", ...window } })
			expect(result.data).toEqual(rows)
			expect(api.sent).toHaveLength(1)
			expect(api.sent[0]).not.toHaveProperty("displayType")
		}).pipe(Effect.provide(api.layer))
	})

	it.effect("passes a display type the API can shape for", () => {
		const api = recordingApi()
		return Effect.gen(function* () {
			yield* getPromqlChart({ data: { promql: "up", displayType: "line", ...window } })
			expect(api.sent[0]).toMatchObject({ query: "up", displayType: "line" })
		}).pipe(Effect.provide(api.layer))
	})
})
