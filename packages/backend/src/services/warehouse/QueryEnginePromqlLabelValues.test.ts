import { describe, it } from "@effect/vitest"
import { Array as Arr, ConfigProvider, Effect, Exit, Layer, Schema } from "effect"
import { strict as assert } from "node:assert"
import { OrgId, UserId } from "@maple/domain"
import { QueryEngineExecuteRequest } from "@maple/domain/query-engine"
import type { TenantContext } from "@maple/domain/http"
import type { CompiledQuery } from "@maple/query-engine/ch"
import { compiledQueryOf } from "@maple/query-engine/execution"
import { BucketCacheService } from "@maple/query-engine/caching"
import { makeEdgeCacheService, makeMemoryBackend, EdgeCacheService } from "@maple/cache"
import { QueryEngineService } from "./QueryEngineService"
import { WarehouseQueryService, type WarehouseQueryServiceApi } from "./WarehouseQueryService"

// A `promqlLabelValues` request answers through PromQL label discovery, as an attribute-values result.

const tenant: TenantContext = {
	orgId: Schema.decodeSync(OrgId)("org_test"),
	userId: Schema.decodeSync(UserId)("user_test"),
	roles: [],
	authMode: "self_hosted",
}

// The stored key is dotted; the Prometheus label is `http_route`.
const ROWS = [
	{ attributeKey: "http.route", attributeValue: "/api/users", usageCount: 2 },
	{ attributeKey: "http.route", attributeValue: "/api/orders", usageCount: 5 },
]

// SAFETY: label discovery reads only `compiledQuery`; any other method would fail the test loudly.
const stub = {
	compiledQuery: <Output>(_tenant: unknown, compiled: CompiledQuery<Output>) =>
		compiledQueryOf(compiled).decodeRows(ROWS).pipe(Effect.orDie),
	warmRoute: () => Effect.void,
} as WarehouseQueryServiceApi

const edge = Layer.succeed(EdgeCacheService, makeEdgeCacheService(makeMemoryBackend()))
const layer = Layer.effect(QueryEngineService, QueryEngineService.make).pipe(
	Layer.provide(Layer.succeed(WarehouseQueryService, stub)),
	Layer.provide(edge),
	Layer.provide(BucketCacheService.layer.pipe(Layer.provide(edge))),
	Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ QE_BUCKET_CACHE_ENABLED: "false" }))),
)

const request = (label: string, match?: string) =>
	new QueryEngineExecuteRequest({
		startTime: "2026-01-01 00:00:00",
		endTime: "2026-01-01 01:00:00",
		query: {
			kind: "promqlLabelValues",
			source: "metrics",
			label,
			...(match === undefined ? undefined : { match }),
		},
	})

describe("QueryEngineService.execute on promqlLabelValues", () => {
	it.effect("lists a Prometheus label's values from its dotted attribute key, sorted", () =>
		Effect.gen(function* () {
			const qe = yield* QueryEngineService
			const response = yield* qe.execute(tenant, request("http_route"))
			assert.equal(response.result.kind, "attributeValues")
			assert.deepEqual(
				response.result.kind === "attributeValues"
					? Arr.map(response.result.data, (row) => row.value)
					: [],
				["/api/orders", "/api/users"],
			)
		}).pipe(Effect.provide(layer)),
	)

	it.effect("lists every value for a blank selector, as for none", () =>
		Effect.gen(function* () {
			const qe = yield* QueryEngineService
			const response = yield* qe.execute(tenant, request("http_route", "  "))
			assert.deepEqual(
				response.result.kind === "attributeValues"
					? Arr.map(response.result.data, (row) => row.value)
					: [],
				["/api/orders", "/api/users"],
			)
		}).pipe(Effect.provide(layer)),
	)

	it.effect("refuses a window wider than the query engine's range ceiling", () =>
		Effect.gen(function* () {
			const qe = yield* QueryEngineService
			const wide = new QueryEngineExecuteRequest({
				startTime: "2025-01-01 00:00:00",
				endTime: "2026-01-01 00:00:00",
				query: { kind: "promqlLabelValues", source: "metrics", label: "http_route" },
			})
			const exit = yield* Effect.exit(qe.execute(tenant, wide))
			assert.ok(Exit.isFailure(exit))
			assert.match(String(exit.cause), /Time range too large/)
		}).pipe(Effect.provide(layer)),
	)

	it.effect("answers an invalid label name with a validation error", () =>
		Effect.gen(function* () {
			const qe = yield* QueryEngineService
			const exit = yield* Effect.exit(qe.execute(tenant, request("bad-label")))
			assert.ok(Exit.isFailure(exit))
			const error = Exit.isFailure(exit) ? exit.cause : undefined
			assert.match(String(error), /QueryEngineValidationError/)
		}).pipe(Effect.provide(layer)),
	)
})
