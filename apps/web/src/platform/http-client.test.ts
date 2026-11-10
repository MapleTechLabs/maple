import { assert, describe, it } from "@effect/vitest"
import { MapleInternalApi } from "@maple/domain/http"
import { Effect, Fiber, Layer, Result } from "effect"
import { HttpApiClient } from "effect/http-api"
import { TestClock } from "effect/testing"
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/http"

import { PEER_OUTAGE_GRACE_MS } from "@maple/web-data/lib/peer-reachability"
import {
	runWarehouseQuery,
	WarehouseQueryError,
	WarehouseUnreachableError,
} from "@maple/web-data/warehouse/effect-utils"
import { MapleInternalHttp } from "@maple/web-data/warehouse/warehouse-services"
import { ApiReachabilityLive } from "../data/warehouse"
import { apiBaseUrl } from "./api-base-url"
import { withRequestTimeout } from "./http-client"
import { isRetryableTransportError } from "./retry-policy"

const NEVER_RESPONDS: typeof globalThis.fetch = () => new Promise<Response>(() => {})

const get = (fetchStub: typeof globalThis.fetch, url = "https://api.test/anything") =>
	Effect.gen(function* () {
		const client = withRequestTimeout(yield* HttpClient.HttpClient)
		return yield* client.get(url)
	}).pipe(Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, fetchStub))

/**
 * The deadline used to live in the fetch implementation as
 * `signal: init?.signal ?? AbortSignal.timeout(…)`. `FetchHttpClient` always
 * supplies its own signal, so that branch never ran and a stalled request stayed
 * pending forever.
 */
describe("withRequestTimeout", () => {
	it.effect("fails a request that never responds, rather than hanging", () =>
		Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(Effect.result(get(NEVER_RESPONDS)))

			yield* TestClock.adjust("44 seconds")
			assert.isUndefined(fiber.pollUnsafe(), "gave up before the deadline")

			yield* TestClock.adjust("1 second")
			const result = yield* Fiber.join(fiber)
			assert.isTrue(Result.isFailure(result), "request outlived the deadline")
			assert.instanceOf(
				Result.isFailure(result) ? result.failure : undefined,
				HttpClientError.HttpClientError,
			)
		}),
	)

	it.effect("is not retried, so a hung read fails after one deadline", () =>
		Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(Effect.flip(get(NEVER_RESPONDS)))
			yield* TestClock.adjust("45 seconds")
			const error = yield* Fiber.join(fiber)

			assert.isFalse(isRetryableTransportError(error))
		}),
	)

	it.effect("leaves a responding request alone", () =>
		Effect.gen(function* () {
			const response = yield* get(async () => new Response("{}", { status: 200 }))

			assert.strictEqual(response.status, 200)
		}),
	)
})

const DROPS: typeof globalThis.fetch = () => Promise.reject(new TypeError("Failed to fetch"))
const ANSWERS_500: typeof globalThis.fetch = async () => new Response("{}", { status: 500 })

// `runWarehouseQuery` runs on the internal client; these reads go through `get` instead.
const InternalHttp = Layer.effect(MapleInternalHttp, HttpApiClient.make(MapleInternalApi)).pipe(
	Layer.provide(FetchHttpClient.layer),
)

/** A warehouse read over the app's client, failing as the dashboard would report it. */
const queryFailure = (fetchStub: typeof globalThis.fetch) =>
	runWarehouseQuery("listThings", () => get(fetchStub, `${apiBaseUrl}/internal/things`)).pipe(
		Effect.provide([ApiReachabilityLive, InternalHttp]),
		Effect.flip,
	)

describe("API reachability", () => {
	it.effect("reports a dropped connection as unreachable, then as an outage once it lasts", () =>
		Effect.gen(function* () {
			// Any response ends a run left over from another test.
			yield* get(ANSWERS_500, `${apiBaseUrl}/internal/things`)

			assert.instanceOf(yield* queryFailure(DROPS), WarehouseUnreachableError)

			yield* TestClock.adjust(PEER_OUTAGE_GRACE_MS)
			assert.instanceOf(yield* queryFailure(DROPS), WarehouseQueryError)
		}),
	)

	it.effect("starts a new grace window after the API answers, even with a 500", () =>
		Effect.gen(function* () {
			yield* get(ANSWERS_500, `${apiBaseUrl}/internal/things`)
			assert.instanceOf(yield* queryFailure(DROPS), WarehouseUnreachableError)

			yield* TestClock.adjust(PEER_OUTAGE_GRACE_MS - 1)
			yield* get(ANSWERS_500, `${apiBaseUrl}/internal/things`)
			yield* TestClock.adjust(PEER_OUTAGE_GRACE_MS - 1)

			assert.instanceOf(yield* queryFailure(DROPS), WarehouseUnreachableError)
		}),
	)
})
