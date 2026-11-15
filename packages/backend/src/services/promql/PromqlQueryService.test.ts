import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Schema, Array as Arr, Record as Rec, String as Str } from "effect"
import { compiledQueryOf } from "@maple/query-engine/execution"
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
	it.effect("refuses a widget window that ends before it starts", () =>
		Effect.gen(function* () {
			const service = yield* PromqlQueryService
			const error = yield* Effect.flip(
				service.widget(tenant, {
					query: "vector(1)",
					startTime: "2026-01-02 00:00:00",
					endTime: "2026-01-01 00:00:00",
				}),
			)
			expect(error._tag).toBe("@maple/backend/promql/PromqlBadQueryError")
		}).pipe(Effect.provide(TestLayer)),
	)

	it.effect("runs a widget query on a step picked from the window", () =>
		Effect.gen(function* () {
			const service = yield* PromqlQueryService
			const result = yield* service.widget(tenant, {
				query: "vector($__range_s)",
				startTime: "2026-01-01 00:00:00",
				endTime: "2026-01-02 00:00:00",
				maxDataPoints: 100,
				displayType: "stat",
			})
			// A day at 100 points rounds up to a 15 minute step; a stat reads newest first.
			expect(result.stepSeconds).toBe(900)
			expect(result.resultType).toBe("matrix")
			expect(result.rows[0]).toEqual({ bucket: "2026-01-02T00:00:00.000Z", value: 86_400 })
		}).pipe(Effect.provide(TestLayer)),
	)
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

const T0 = Date.UTC(2026, 6, 15, 12)

const selectorRow = (attributes: Record<string, string>) => ({
	series: JSON.stringify(attributes),
	// A selector row names its metric with the stored unit after U+001F; this one has none.
	metricName: "http.requests\u001f",
	serviceName: "api",
	attributes,
	resourceAttributes: { "service.name": "api" },
	le: "0",
	...Rec.fromEntries(
		Arr.map(
			["firstT", "firstV", "lastT", "lastV", "prevT", "prevV", "count", "sum", "min", "max"],
			(field) => [field, [1]] as const,
		),
	),
	...Rec.fromEntries(
		Arr.map(
			["sumSquares", "increase", "resets", "changes", "sumT", "sumTT", "sumTV"],
			(field) => [field, [0]] as const,
		),
	),
	end: [T0],
	values: [[]],
})

/** Answers each warehouse read by the table it reads, recording the SQL that ran. */
const recordingWarehouse = () => {
	const statements: Array<string> = []
	const rowsFor = (sql: string): ReadonlyArray<Record<string, unknown>> => {
		if (Str.includes("FROM metrics_sum")(sql)) {
			return [selectorRow({ "http.route": "/checkout" }), selectorRow({ "http.route": "/cart" })]
		}
		if (Str.includes("MetricDescription")(sql)) {
			return [
				{
					metricName: "http.requests",
					metricType: "sum",
					unit: "1",
					description: "Requests",
					isMonotonic: 1,
				},
				{
					metricName: "http.duration",
					metricType: "histogram",
					unit: "s",
					description: "Latency",
					isMonotonic: 0,
				},
			]
		}
		if (Str.includes("AS serviceName")(sql)) return [{ serviceName: "api" }, { serviceName: "worker" }]
		if (Str.includes("FROM metric_catalog")(sql)) {
			return [{ metricName: "http.requests", metricType: "sum", unit: "", isMonotonic: 1 }]
		}
		if (
			Str.includes("FROM attribute_keys_hourly")(sql) &&
			Str.includes("AttributeScope = 'resource'")(sql)
		) {
			return [
				{ attributeKey: "host.name", usageCount: 5 },
				{ attributeKey: "service.version", usageCount: 5 },
			]
		}
		if (Str.includes("FROM attribute_keys_hourly")(sql)) {
			return [
				{ attributeKey: "http.route", usageCount: 10 },
				{ attributeKey: "http_route", usageCount: 1 },
			]
		}
		if (Str.includes("FROM attribute_values_hourly")(sql) && Str.includes("service.instance.id")(sql)) {
			return [{ attributeValue: "pod-1" }]
		}
		if (Str.includes("FROM attribute_values_hourly")(sql)) return [{ attributeValue: "/checkout" }]
		return []
	}
	const warehouse = makeWarehouseServiceStub({
		compiledQuery: (_tenant, compiled) => {
			const query = compiledQueryOf(compiled)
			statements.push(query.sql)
			return query.decodeRows(rowsFor(query.sql))
		},
		// Selector reads are size-bounded; record them the same way.
		compiledQueryBounded: (_tenant, compiled) => {
			const query = compiledQueryOf(compiled)
			statements.push(query.sql)
			return query.decodeRows(rowsFor(query.sql))
		},
	})
	const layer = Layer.effect(PromqlQueryService, PromqlQueryService.make).pipe(
		Layer.provide(Layer.succeed(WarehouseQueryService, warehouse)),
	)
	return { statements, layer }
}

const window = { startMs: T0 - 3_600_000, endMs: T0 }

const ORG_FILTER = /OrgId = 'org_promql'/

describe("PromqlQueryService discovery", () => {
	it.effect("refuses more match[] selectors than a query may read", () => {
		const { statements, layer } = recordingWarehouse()
		return Effect.gen(function* () {
			const service = yield* PromqlQueryService
			const matches = Array.from({ length: 21 }, (_, i) => `up{i="${i}"}`)
			const error = yield* Effect.flip(service.series(tenant, { ...window, matches }))
			expect(error.message).toMatch(/more than 20 selectors/)
			expect(statements).toHaveLength(0)
		}).pipe(Effect.provide(layer))
	})

	it.effect("returns the label sets a match[] selector selects, read through org-scoped queries", () => {
		const { statements, layer } = recordingWarehouse()
		return Effect.gen(function* () {
			const service = yield* PromqlQueryService
			const series = yield* service.series(tenant, {
				...window,
				matches: ['http_requests_total{http_route=~"/c.*"}'],
			})
			expect(series).toEqual([
				{ __name__: "http_requests_total", http_route: "/checkout", job: "api" },
				{ __name__: "http_requests_total", http_route: "/cart", job: "api" },
			])
			expect(statements.length).toBe(2)
			for (const sql of statements) expect(sql).toMatch(ORG_FILTER)
		}).pipe(Effect.provide(layer))
	})

	it.effect("refuses a match[] that is not a selector or matches everything", () =>
		Effect.gen(function* () {
			const service = yield* PromqlQueryService
			const notSelector = yield* Effect.flip(
				service.series(tenant, { ...window, matches: ["sum(up)"] }),
			)
			expect(notSelector.message).toMatch(/not a series selector/)
			const empty = yield* Effect.flip(service.series(tenant, { ...window, matches: ['{job=~".*"}'] }))
			expect(empty.message).toMatch(/at least one non-empty matcher/)
		}).pipe(Effect.provide(TestLayer)),
	)

	it.effect("lists label names from the catalog and the attribute rollup without a selector", () => {
		const { statements, layer } = recordingWarehouse()
		return Effect.gen(function* () {
			const service = yield* PromqlQueryService
			const names = yield* service.labelNames(tenant, { ...window, matches: [] })
			expect(names).toEqual(["__name__", "host_name", "http_route", "instance", "job"])
			expect(Arr.some(statements, (sql) => Str.includes("metrics_sum")(sql))).toBe(false)
			for (const sql of statements) expect(sql).toMatch(ORG_FILTER)
		}).pipe(Effect.provide(layer))
	})

	it.effect("reads label values from the rollup for every raw key the label normalizes from", () => {
		const { statements, layer } = recordingWarehouse()
		return Effect.gen(function* () {
			const service = yield* PromqlQueryService
			const values = yield* service.labelValues(tenant, { ...window, matches: [], name: "http_route" })
			expect(values).toEqual(["/checkout"])
			const valuesSql = Arr.findFirst(statements, (sql) => Str.includes("attribute_values_hourly")(sql))
			expect(Option.getOrThrow(valuesSql)).toMatch(/AttributeKey IN \('http\.route', 'http_route'\)/)
			expect(Option.getOrThrow(valuesSql)).toMatch(ORG_FILTER)
			expect(Option.getOrThrow(valuesSql)).toMatch(/AttributeScope = 'metric'/)
		}).pipe(Effect.provide(layer))
	})

	it.effect("reads instance values from service.instance.id in the resource rollup", () => {
		const { statements, layer } = recordingWarehouse()
		return Effect.gen(function* () {
			const service = yield* PromqlQueryService
			const values = yield* service.labelValues(tenant, { ...window, matches: [], name: "instance" })
			expect(values).toEqual(["pod-1"])
			const valuesSql = Arr.findFirst(statements, (sql) => Str.includes("attribute_values_hourly")(sql))
			expect(Option.getOrThrow(valuesSql)).toMatch(/AttributeScope = 'resource'/)
		}).pipe(Effect.provide(layer))
	})

	it.effect("lists metric names and jobs from the catalog", () => {
		const { layer } = recordingWarehouse()
		return Effect.gen(function* () {
			const service = yield* PromqlQueryService
			const names = yield* service.labelValues(tenant, { ...window, matches: [], name: "__name__" })
			expect(names).toEqual(["http_requests_total"])
			const jobs = yield* service.labelValues(tenant, { ...window, matches: [], name: "job" })
			expect(jobs).toEqual(["api", "worker"])
		}).pipe(Effect.provide(layer))
	})

	it.effect("answers metadata keyed by metric family", () => {
		const { layer } = recordingWarehouse()
		return Effect.gen(function* () {
			const service = yield* PromqlQueryService
			const metadata = yield* service.metadata(tenant, window)
			expect(Rec.fromEntries(metadata)).toEqual({
				http_duration_seconds: [{ type: "histogram", help: "Latency", unit: "seconds" }],
				http_requests_total: [{ type: "counter", help: "Requests", unit: "" }],
			})
		}).pipe(Effect.provide(layer))
	})

	it.effect("refuses an invalid label name", () =>
		Effect.gen(function* () {
			const service = yield* PromqlQueryService
			const error = yield* Effect.flip(
				service.labelValues(tenant, { ...window, matches: [], name: "bad-name" }),
			)
			expect(error.message).toMatch(/invalid label name/)
		}).pipe(Effect.provide(TestLayer)),
	)
})
