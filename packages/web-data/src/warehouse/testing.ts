import { MapleInternalApi } from "@maple/domain/http"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { MapleInternalHttp, WarehouseExecutor } from "./warehouse-services"

const unmockedFetch = (): Promise<Response> => Promise.reject(new Error("unmocked warehouse request"))

const MockedWarehouseLayer = Layer.mergeAll(
	Layer.mock(WarehouseExecutor, {}),
	Layer.effect(MapleInternalHttp, HttpApiClient.make(MapleInternalApi)).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(Layer.succeed(FetchHttpClient.Fetch, unmockedFetch)),
	),
)

/**
 * For tests that replace `executeQueryEngine` / `runWarehouseQuery` with mocks: the services only
 * satisfy the requirements, and any call that reaches them fails as unmocked.
 */
export const mockedWarehouse = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	// A test body is its own entry point.
	// oxlint-disable-next-line effecttsgo/strict-effect-provide
	effect.pipe(Effect.provide(MockedWarehouseLayer))
