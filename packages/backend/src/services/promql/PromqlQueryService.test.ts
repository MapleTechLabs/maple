import { describe, expect, it } from "@effect/vitest"
import { Array as Arr, Effect, Layer, Record as Rec, Schema } from "effect"
import { DEFAULT_LIMITS } from "@maple/promql"
import { METRIC_UNIT_SEPARATOR } from "@maple/query-engine/ch"
import { compiledQueryOf, type CompiledQueryInput } from "@maple/query-engine/execution"
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

/** A selector row's per-bucket statistic columns; empty is enough for a read that is refused. */
const STAT_COLUMNS = [
	"end",
	"firstT",
	"firstV",
	"lastT",
	"lastV",
	"prevT",
	"prevV",
	"count",
	"sum",
	"min",
	"max",
].concat(["sumSquares", "increase", "resets", "changes", "sumT", "sumTT", "sumTV", "values"])

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

	it.effect("refuses timestamps a date cannot hold as a bad query, not a defect", () =>
		Effect.gen(function* () {
			const far = yield* failureOf({ query: "up", startMs: 1e20, endMs: 1e20, stepMs: 0 })
			expect(far._tag).toBe("@maple/backend/promql/PromqlBadQueryError")
			const infiniteStep = yield* failureOf({
				query: "up",
				startMs: 0,
				endMs: 10_000,
				stepMs: Infinity,
			})
			expect(infiniteStep._tag).toBe("@maple/backend/promql/PromqlBadQueryError")
			const pinned = yield* failureOf({ query: "up @ 1e14", startMs: 0, endMs: 0, stepMs: 0 })
			expect(pinned._tag).toBe("@maple/backend/promql/PromqlBadQueryError")
			expect(pinned.message).toMatch(/outside the supported time range/)
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

	it.effect("counts a histogram once against the per-selector metric limit", () =>
		Effect.gen(function* () {
			// 40 histograms are 120 Prometheus series families (_bucket, _count, _sum) but 40 metrics.
			const catalog = Arr.makeBy(40, (i) => ({
				metricName: `lat${i}`,
				metricType: "histogram",
				unit: "s",
				isMonotonic: 0,
			}))
			const answer = (
				_tenant: unknown,
				compiled: CompiledQueryInput<unknown>,
				opts: { context?: string },
			) =>
				compiledQueryOf(compiled)
					.decodeRows(opts.context === "promqlCatalog" ? catalog : [])
					.pipe(Effect.orDie)
			const warehouse = makeWarehouseServiceStub({
				// SAFETY: the service hands the stub plain compiled queries, never a capability compile.
				compiledQuery: answer as never,
				// SAFETY: as above; selector reads go through the bounded read.
				compiledQueryBounded: answer as never,
			})
			const result = yield* Effect.gen(function* () {
				const service = yield* PromqlQueryService
				return yield* service.query(tenant, {
					query: '{__name__=~"lat.*"}',
					startMs: 3_600_000,
					endMs: 3_600_000,
					stepMs: 0,
				})
			}).pipe(
				Effect.provide(
					Layer.effect(PromqlQueryService, PromqlQueryService.make).pipe(
						Layer.provide(Layer.succeed(WarehouseQueryService, warehouse)),
					),
				),
			)
			expect(result.resultType).toBe("vector")
		}),
	)

	it.effect("refuses a selector read that hit its row limit, even when the le filter would hide it", () =>
		Effect.gen(function* () {
			// One more row than the cap; only one of them has le="0.5", so a cut read would look small.
			const selectorRows = Arr.makeBy(DEFAULT_LIMITS.maxSeries + 1, (i) => ({
				series: String(i),
				metricName: `lat${METRIC_UNIT_SEPARATOR}s`,
				serviceName: "api",
				attributes: { route: `/r${i}` },
				resourceAttributes: {},
				le: i === 0 ? "0.5" : "1",
				...Rec.fromEntries(Arr.map(STAT_COLUMNS, (key) => [key, []] as const)),
			}))
			const answer = (
				_tenant: unknown,
				compiled: CompiledQueryInput<unknown>,
				opts: { context?: string },
			) => {
				const query = compiledQueryOf(compiled)
				const rows =
					opts.context === "promqlCatalog"
						? [{ metricName: "lat", metricType: "histogram", unit: "s", isMonotonic: 0 }]
						: selectorRows
				return query.decodeRows(rows).pipe(Effect.orDie)
			}
			const warehouse = makeWarehouseServiceStub({
				// SAFETY: the service hands the stub plain compiled queries, never a capability compile.
				compiledQuery: answer as never,
				// SAFETY: as above; selector reads go through the bounded read.
				compiledQueryBounded: answer as never,
			})
			const error = yield* Effect.gen(function* () {
				const service = yield* PromqlQueryService
				return yield* Effect.flip(
					service.query(tenant, {
						query: 'lat_seconds_bucket{le=~"0.5"}',
						startMs: 3_600_000,
						endMs: 3_600_000,
						stepMs: 0,
					}),
				)
			}).pipe(
				Effect.provide(
					Layer.effect(PromqlQueryService, PromqlQueryService.make).pipe(
						Layer.provide(Layer.succeed(WarehouseQueryService, warehouse)),
					),
				),
			)
			expect(error.message).toMatch(/selects more than 10000 series/)
		}),
	)
})
