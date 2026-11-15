import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import type { TenantContext } from "@maple/domain/http"
import { OrgId, UserId } from "@maple/primitives"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { WarehouseResponseLimitError } from "@maple/query-engine/execution"
import { PromqlQueryService } from "./PromqlQueryService"

const tenant: TenantContext = {
	orgId: Schema.decodeSync(OrgId)("org_promql"),
	userId: Schema.decodeSync(UserId)("user_promql"),
	roles: [],
	authMode: "self_hosted",
}

// Every case here fails before reading: the stub dies if a query reaches the warehouse.
const TestLayer = Layer.effect(PromqlQueryService, PromqlQueryService.make).pipe(
	Layer.provide(Layer.succeed(WarehouseQueryService, makeWarehouseServiceStub())),
)

const failureOf = (input: { query: string; startMs: number; endMs: number; stepMs: number }) =>
	Effect.gen(function* () {
		const service = yield* PromqlQueryService
		return yield* Effect.flip(service.query(tenant, input))
	}).pipe(Effect.provide(TestLayer))

describe("PromqlQueryService", () => {
	it.effect("answers a query without selectors without reading the warehouse", () =>
		Effect.gen(function* () {
			const service = yield* PromqlQueryService
			const result = yield* service.query(tenant, {
				query: "1 + 2 * 3",
				startMs: 1000,
				endMs: 1000,
				stepMs: 0,
			})
			expect(result).toEqual({ resultType: "scalar", result: { t: 1000, v: 7 } })
		}).pipe(Effect.provide(TestLayer)),
	)

	it.effect("reports invalid PromQL as a bad query with its position", () =>
		Effect.gen(function* () {
			const error = yield* failureOf({ query: "sum(rate(x[5m])", startMs: 0, endMs: 0, stepMs: 0 })
			expect(error._tag).toBe("@maple/backend/promql/PromqlBadQueryError")
			expect(error.message).toMatch(/syntax error|unexpected end/)
		}),
	)

	it.effect("refuses more than 11000 points per series, as Prometheus does", () =>
		Effect.gen(function* () {
			const error = yield* failureOf({ query: "up", startMs: 0, endMs: 3_600_000, stepMs: 100 })
			expect(error.message).toMatch(/maximum resolution of 11000 points/)
		}),
	)

	it.effect("refuses a range that ends before it starts and a zero step", () =>
		Effect.gen(function* () {
			const backwards = yield* failureOf({ query: "up", startMs: 10_000, endMs: 0, stepMs: 1000 })
			expect(backwards.message).toMatch(/end timestamp must not be before start time/)
			const zeroStep = yield* failureOf({ query: "up", startMs: 0, endMs: 10_000, stepMs: 0 })
			expect(zeroStep.message).toMatch(/positive integer/)
		}),
	)

	it.effect("reports evaluation errors as execution errors", () =>
		Effect.gen(function* () {
			const error = yield* failureOf({ query: "topk(NaN, vector(1))", startMs: 0, endMs: 0, stepMs: 0 })
			expect(error._tag).toBe("@maple/backend/promql/PromqlExecutionError")
		}),
	)

	it.effect("fails cleanly when a selector's buckets would not fit in memory", () =>
		Effect.gen(function* () {
			// The catalog knows `up`; every bounded read reports the response ceiling.
			const warehouse = makeWarehouseServiceStub({
				compiledQuery: () =>
					Effect.succeed([{ metricName: "up", metricType: "gauge", unit: "", isMonotonic: 0 }]),
				compiledQueryBounded: () =>
					Effect.fail(new WarehouseResponseLimitError({ kind: "bytes", message: "too big" })),
			})
			const layer = Layer.effect(PromqlQueryService, PromqlQueryService.make).pipe(
				Layer.provide(Layer.succeed(WarehouseQueryService, warehouse)),
			)
			const error = yield* Effect.gen(function* () {
				const service = yield* PromqlQueryService
				return yield* Effect.flip(
					service.query(tenant, { query: "up", startMs: 0, endMs: 3_600_000, stepMs: 60_000 }),
				)
			}).pipe(Effect.provide(layer))
			expect(error._tag).toBe("@maple/backend/promql/PromqlExecutionError")
			expect(error.message).toMatch(/too many samples/)
		}),
	)

	const withCatalog = (rows: ReadonlyArray<Record<string, unknown>>) =>
		Layer.effect(PromqlQueryService, PromqlQueryService.make).pipe(
			Layer.provide(
				Layer.succeed(
					WarehouseQueryService,
					makeWarehouseServiceStub({ compiledQuery: () => Effect.succeed(rows) }),
				),
			),
		)

	const errorWith = (rows: ReadonlyArray<Record<string, unknown>>, query: string) =>
		Effect.gen(function* () {
			const service = yield* PromqlQueryService
			return yield* Effect.flip(service.query(tenant, { query, startMs: 0, endMs: 0, stepMs: 0 }))
		}).pipe(Effect.provide(withCatalog(rows)))

	const gauge = (i: number) => ({ metricName: `m_${i}`, metricType: "gauge", unit: "", isMonotonic: 0 })

	it.effect("refuses a selector that matches more than 100 metrics", () =>
		Effect.gen(function* () {
			const rows = Array.from({ length: 101 }, (_, i) => gauge(i))
			const error = yield* errorWith(rows, '{__name__=~"m_.*"}')
			expect(error.message).toMatch(/matches 101 metrics, at most 100/)
		}),
	)

	it.effect("refuses to resolve names against a catalog that was cut off", () =>
		Effect.gen(function* () {
			const rows = Array.from({ length: 50_001 }, (_, i) => gauge(i))
			const error = yield* errorWith(rows, "m_1")
			expect(error.message).toMatch(/more than 50000 metrics/)
		}),
	)
})
