import { describe, expect, it } from "@effect/vitest"
import { MapleInternalApi } from "@maple/domain/http"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { getRawSqlChart } from "./raw-sql-chart"
import { MapleInternalHttp, WarehouseExecutor } from "./warehouse-services"

const rows = [
	{ bucket: "2026-11-16 10:00:00", requests: 3 },
	{ bucket: "2026-11-16 10:01:00", requests: 5 },
]

const answerRawSql = (): Promise<Response> =>
	Promise.resolve(
		Response.json({
			data: rows,
			meta: { rowCount: rows.length, columns: ["bucket", "requests"], granularitySeconds: 60 },
		}),
	)

const ApiLayer = Layer.mergeAll(
	Layer.mock(WarehouseExecutor, {}),
	Layer.effect(
		MapleInternalHttp,
		HttpApiClient.make(MapleInternalApi, { baseUrl: "https://api.test" }),
	).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(Layer.succeed(FetchHttpClient.Fetch, answerRawSql)),
	),
)

const withApi = <A, E>(effect: Effect.Effect<A, E, MapleInternalHttp | WarehouseExecutor>) =>
	effect.pipe(Effect.provide(ApiLayer))

const window = { startTime: "2026-11-16 10:00:00", endTime: "2026-11-16 11:00:00" }

describe("getRawSqlChart", () => {
	it.effect("runs a widget saved without a display type and returns its rows as the API sent them", () =>
		withApi(
			Effect.gen(function* () {
				const result = yield* getRawSqlChart({ data: { sql: "SELECT 1", ...window } })
				expect(result.data).toEqual(rows)
				expect(result.meta.displayType).toBeUndefined()
			}),
		),
	)

	it.effect("treats a display type this build does not know like a missing one", () =>
		withApi(
			Effect.gen(function* () {
				const result = yield* getRawSqlChart({
					data: { sql: "SELECT 1", displayType: "sankey", ...window },
				})
				expect(result.data).toEqual(rows)
				expect(result.meta.displayType).toBeUndefined()
			}),
		),
	)

	it.effect("still reshapes a line chart's rows into series", () =>
		withApi(
			Effect.gen(function* () {
				const result = yield* getRawSqlChart({
					data: { sql: "SELECT 1", displayType: "line", ...window },
				})
				expect(result.meta.displayType).toBe("line")
				expect(result.data).toHaveLength(2)
				expect(result.data[0]).toMatchObject({ bucket: expect.any(String), requests: 3 })
			}),
		),
	)
})
