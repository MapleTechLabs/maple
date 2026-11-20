import * as Policy from "@maple/domain/policy"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Schema, Array as Arr, Record as Rec, String as Str } from "effect"
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
	permissions: Policy.grantsOf([]),
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
].concat(["sumSquares", "resetSum", "resets", "changes", "sumT", "sumTT", "sumTV", "staleT", "values"])

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
			expect(result).toEqual({ resultType: "scalar", result: { t: 1000, v: 7 }, warnings: [] })
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
			expect(error.message).toMatch(/maximum resolution of 11,000 points/)
		}),
	)

	it.effect("counts whole steps, so 11,000 steps and a remainder still run", () =>
		Effect.gen(function* () {
			const service = yield* PromqlQueryService
			// 16 501 s at 1.5 s is 11 000 whole steps plus 1 s.
			const result = yield* service.query(tenant, {
				query: "1",
				startMs: 0,
				endMs: 16_501_000,
				stepMs: 1500,
			})
			expect(result.resultType).toBe("matrix")
		}).pipe(Effect.provide(TestLayer)),
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
			// The parser refuses it first, with Prometheus' own message.
			expect(pinned.message).toMatch(/timestamp out of bounds for @ modifier/)
		}),
	)

	it.effect("refuses a query whose ranges, offsets or @ widen its reads past the cap, before reading", () =>
		Effect.gen(function* () {
			const now = Date.UTC(2026, 0, 1)
			const refused = (query: string) =>
				Effect.map(failureOf({ query, startMs: now, endMs: now, stepMs: 0 }), (error) => [
					error._tag,
					error.message,
				])
			const expected = ["@maple/backend/promql/PromqlBadQueryError", expect.stringMatching(/400 days/)]
			expect(yield* refused("rate(up[10y])")).toEqual(expected)
			expect(yield* refused("up offset 500d")).toEqual(expected)
			expect(yield* refused("up + (up @ 0)")).toEqual(expected)
			expect(yield* refused("max_over_time(up[1h:1h] offset 450d)")).toEqual(expected)
			const service = yield* PromqlQueryService
			const widget = yield* Effect.flip(
				service.widget(tenant, {
					query: "rate(up[10y])",
					startTime: "2026-01-01 00:00:00",
					endTime: "2026-01-01 01:00:00",
				}),
			)
			expect([widget._tag, widget.message]).toEqual(expected)
		}).pipe(Effect.provide(TestLayer)),
	)

	it.effect("refuses a range query over a range vector or string as a bad query, as Prometheus does", () =>
		Effect.gen(function* () {
			const matrix = yield* failureOf({ query: "up[5m]", startMs: 0, endMs: 60_000, stepMs: 15_000 })
			expect(matrix._tag).toBe("@maple/backend/promql/PromqlBadQueryError")
			expect(matrix.message).toMatch(/invalid expression type "range vector" for range query/)
			const text = yield* failureOf({ query: '"x"', startMs: 0, endMs: 60_000, stepMs: 15_000 })
			expect(text._tag).toBe("@maple/backend/promql/PromqlBadQueryError")
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
			["sumSquares", "resetSum", "resets", "changes", "sumT", "sumTT", "sumTV", "staleT"],
			(field) => [field, [0]] as const,
		),
	),
	end: [T0],
	values: [[]],
})

/** A series discovery row: one stored metric's label set. */
const labelsRow = (metricName: string, attributes: Record<string, string>) => ({
	metricName: `${metricName}\u001f`,
	labelKey: JSON.stringify([metricName, attributes]),
	serviceName: "api",
	attributes,
	resourceAttributes: { "service.name": "api" },
	bounds: [],
})

/** Answers each warehouse read by the table it reads, recording the SQL that ran. */
const recordingWarehouse = (catalog?: ReadonlyArray<Record<string, unknown>>) => {
	const statements: Array<string> = []
	const rowsFor = (sql: string): ReadonlyArray<Record<string, unknown>> => {
		if (Str.includes("AS labelKey")(sql)) {
			if (!Str.includes("FROM metrics_sum")(sql) && !Str.includes("FROM metrics_gauge")(sql)) return []
			return catalog === undefined
				? [
						labelsRow("http.requests", { "http.route": "/checkout" }),
						labelsRow("http.requests", { "http.route": "/cart" }),
					]
				: [
						labelsRow("m_7", { "http.route": "/checkout" }),
						labelsRow("m_140", { "http.route": "/cart" }),
					]
		}
		if (Str.includes("HAVING (value != '')")(sql) && Str.includes("service.namespace")(sql)) {
			return [{ value: "api" }, { value: "worker" }]
		}
		if (Str.includes("HAVING (value != '')")(sql)) {
			return Str.includes("FROM metrics_gauge")(sql) ? [{ value: "pod-2" }] : [{ value: "pod-1" }]
		}
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
		if (Str.includes("FROM metric_catalog")(sql)) {
			return catalog ?? [{ metricName: "http.requests", metricType: "sum", unit: "", isMonotonic: 1 }]
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
		if (Str.includes("FROM attribute_values_hourly")(sql)) return [{ attributeValue: "/checkout" }]
		return []
	}
	const warehouse = makeWarehouseServiceStub({
		compiledQuery: (_tenant, compiled) => {
			const query = compiledQueryOf(compiled)
			statements.push(query.sql)
			// The real executor refuses any read that is not single-tenant; so does this stub.
			if (query.tenantScope !== "single-tenant")
				return Effect.die(`refused ${query.tenantScope} read: ${query.sql}`)
			return query.decodeRows(rowsFor(query.sql))
		},
		// Selector reads are size-bounded; record them the same way.
		compiledQueryBounded: (_tenant, compiled) => {
			const query = compiledQueryOf(compiled)
			statements.push(query.sql)
			// The real executor refuses any read that is not single-tenant; so does this stub.
			if (query.tenantScope !== "single-tenant")
				return Effect.die(`refused ${query.tenantScope} read: ${query.sql}`)
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
			expect(series.data).toEqual([
				{ __name__: "http_requests_total", http_route: "/checkout", job: "api" },
				{ __name__: "http_requests_total", http_route: "/cart", job: "api" },
			])
			expect(statements.length).toBe(2)
			for (const sql of statements) expect(sql).toMatch(ORG_FILTER)
		}).pipe(Effect.provide(layer))
	})

	it.effect(
		"answers a match[] without a metric name for an org with more metrics than a query may read",
		() => {
			const catalog = Arr.makeBy(150, (i) => ({
				metricName: `m_${i}`,
				metricType: "gauge",
				unit: "",
				isMonotonic: 0,
			}))
			const { statements, layer } = recordingWarehouse(catalog)
			return Effect.gen(function* () {
				const service = yield* PromqlQueryService
				const input = { ...window, matches: ['{job="api"}'] }
				const series = yield* service.series(tenant, input)
				expect(series.data).toEqual([
					{ __name__: "m_7", http_route: "/checkout", job: "api" },
					{ __name__: "m_140", http_route: "/cart", job: "api" },
				])
				const names = yield* service.labelNames(tenant, input)
				expect(names.data).toEqual(["__name__", "http_route", "job"])
				const routes = yield* service.labelValues(tenant, { ...input, name: "http_route" })
				expect(routes.data).toEqual(["/cart", "/checkout"])
				// One read per metric table the catalog resolves to, not one per metric.
				const reads = Arr.filter(statements, (sql) => Str.includes("AS labelKey")(sql))
				expect(reads).toHaveLength(3)
				for (const sql of reads) expect(sql).toMatch(ORG_FILTER)
			}).pipe(Effect.provide(layer))
		},
	)

	it.effect("still refuses a query whose selector matches more than 100 metrics", () => {
		const catalog = Arr.makeBy(150, (i) => ({
			metricName: `m_${i}`,
			metricType: "gauge",
			unit: "",
			isMonotonic: 0,
		}))
		const { layer } = recordingWarehouse(catalog)
		return Effect.gen(function* () {
			const service = yield* PromqlQueryService
			const error = yield* Effect.flip(
				service.query(tenant, { query: '{job="api"}', startMs: T0, endMs: T0, stepMs: 0 }),
			)
			expect(error.message).toMatch(/matches 150 metrics, at most 100/)
		}).pipe(Effect.provide(layer))
	})

	it.effect("reads job and instance values over at most the last day of the range", () => {
		const { statements, layer } = recordingWarehouse()
		return Effect.gen(function* () {
			const service = yield* PromqlQueryService
			const endMs = T0
			yield* service.labelValues(tenant, {
				startMs: endMs - 30 * 86_400_000,
				endMs,
				matches: [],
				name: "job",
			})
			const reads = Arr.filter(statements, (sql) => Str.includes("HAVING (value != '')")(sql))
			expect(reads).toHaveLength(4)
			for (const sql of reads) {
				expect(sql).toContain(`toInt64((${endMs - 86_400_000}))`)
				// `job` is one exact key: no regex over every attribute key of every row.
				expect(sql).not.toMatch(/replaceRegexpAll/)
			}
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
			expect(names.data).toEqual(["__name__", "host_name", "http_route", "instance", "job"])
			expect(Arr.some(statements, (sql) => Str.includes("metrics_sum")(sql))).toBe(false)
			for (const sql of statements) expect(sql).toMatch(ORG_FILTER)
		}).pipe(Effect.provide(layer))
	})

	it.effect("reads label values from the rollup for every raw key the label normalizes from", () => {
		const { statements, layer } = recordingWarehouse()
		return Effect.gen(function* () {
			const service = yield* PromqlQueryService
			const values = yield* service.labelValues(tenant, { ...window, matches: [], name: "http_route" })
			expect(values.data).toEqual(["/checkout"])
			const valuesSql = Arr.findFirst(statements, (sql) => Str.includes("attribute_values_hourly")(sql))
			expect(Option.getOrThrow(valuesSql)).toMatch(/AttributeKey IN \('http\.route', 'http_route'\)/)
			expect(Option.getOrThrow(valuesSql)).toMatch(ORG_FILTER)
			expect(Option.getOrThrow(valuesSql)).toMatch(/AttributeScope = 'metric'/)
		}).pipe(Effect.provide(layer))
	})

	it.effect("reads instance values from the metric tables, which no rollup keeps", () => {
		const { statements, layer } = recordingWarehouse()
		return Effect.gen(function* () {
			const service = yield* PromqlQueryService
			const values = yield* service.labelValues(tenant, { ...window, matches: [], name: "instance" })
			expect(values.data).toEqual(["pod-1", "pod-2"])
			const reads = Arr.filter(
				statements,
				(sql) =>
					Str.includes("service.instance.id")(sql) && Str.includes("HAVING (value != '')")(sql),
			)
			expect(reads).toHaveLength(4)
			for (const sql of reads) expect(sql).toMatch(ORG_FILTER)
			expect(Arr.some(statements, (sql) => Str.includes("attribute_values_hourly")(sql))).toBe(false)
		}).pipe(Effect.provide(layer))
	})

	it.effect("answers no values for a label named like an Object member", () => {
		const { layer } = recordingWarehouse()
		return Effect.gen(function* () {
			const service = yield* PromqlQueryService
			const values = yield* service.labelValues(tenant, {
				...window,
				matches: ['http_requests_total{http_route=~"/c.*"}'],
				name: "constructor",
			})
			expect(values.data).toEqual([])
		}).pipe(Effect.provide(layer))
	})

	it.effect("lists metric names from the catalog and jobs from the metric tables", () => {
		const { layer } = recordingWarehouse()
		return Effect.gen(function* () {
			const service = yield* PromqlQueryService
			const names = yield* service.labelValues(tenant, { ...window, matches: [], name: "__name__" })
			expect(names.data).toEqual(["http_requests_total"])
			const jobs = yield* service.labelValues(tenant, { ...window, matches: [], name: "job" })
			expect(jobs.data).toEqual(["api", "worker"])
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

	it.effect("honors a discovery limit on metadata and label values", () => {
		const { layer } = recordingWarehouse()
		return Effect.gen(function* () {
			const service = yield* PromqlQueryService
			const metadata = yield* service.metadata(tenant, { ...window, limit: 1 })
			expect([...metadata.keys()]).toEqual(["http_duration_seconds"])
			const filtered = yield* service.metadata(tenant, { ...window, metric: "http_requests_total" })
			expect([...filtered.keys()]).toEqual(["http_requests_total"])
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

/** A warehouse whose selector reads find nothing: the catalog and hint label reads answer. */
const emptySelectorWarehouse = () => {
	const contexts: Array<string> = []
	const answer = (_tenant: unknown, compiled: CompiledQueryInput<unknown>, opts: { context?: string }) => {
		const query = compiledQueryOf(compiled)
		contexts.push(opts.context ?? "")
		const rows =
			opts.context === "promqlCatalog"
				? [{ metricName: "http.requests", metricType: "sum", unit: "", isMonotonic: 1 }]
				: opts.context === "promqlHintLabels" && Str.includes("FROM metrics_sum")(query.sql)
					? [labelsRow("http.requests", { "http.route": "/checkout" })]
					: []
		return query.decodeRows(rows).pipe(Effect.orDie)
	}
	const warehouse = makeWarehouseServiceStub({
		// SAFETY: the service hands the stub plain compiled queries, never a capability compile.
		compiledQuery: answer as never,
		// SAFETY: as above; selector reads go through the bounded read.
		compiledQueryBounded: answer as never,
	})
	const layer = Layer.effect(PromqlQueryService, PromqlQueryService.make).pipe(
		Layer.provide(Layer.succeed(WarehouseQueryService, warehouse)),
	)
	return { contexts, layer }
}

describe("PromqlQueryService warnings", () => {
	const at = { startMs: T0, endMs: T0, stepMs: 0 }

	it.effect("names the nearest metrics when a selector's metric is unknown", () => {
		const { layer } = emptySelectorWarehouse()
		return Effect.gen(function* () {
			const service = yield* PromqlQueryService
			const answer = yield* service.query(tenant, { query: "rate(http_request_total[5m])", ...at })
			expect(answer.resultType).toBe("vector")
			expect(answer.warnings).toEqual([
				'no metric named "http_request_total" in the query window; did you mean "http_requests_total"?',
			])
		}).pipe(Effect.provide(layer))
	})

	it.effect("names the nearest labels when a label matcher can match no series", () => {
		const { contexts, layer } = emptySelectorWarehouse()
		return Effect.gen(function* () {
			const service = yield* PromqlQueryService
			const answer = yield* service.query(tenant, {
				query: 'http_requests_total{service_name="api"}',
				...at,
			})
			expect(answer.warnings).toEqual([
				'no sampled series of "http_requests_total" in the query window has a label "service_name"; did you mean "job"?',
			])
			expect(Arr.every(contexts, (context) => context !== "")).toBe(true)
		}).pipe(Effect.provide(layer))
	})

	it.effect("reads no hint labels when the answer has series", () => {
		const { statements, layer } = recordingWarehouse()
		return Effect.gen(function* () {
			const service = yield* PromqlQueryService
			const answer = yield* service.query(tenant, { query: 'http_requests_total{job="api"}', ...at })
			expect(answer.warnings).toEqual([])
			expect(Arr.some(statements, (sql) => Str.includes("AS labelKey")(sql))).toBe(false)
		}).pipe(Effect.provide(layer))
	})

	it.effect("warns when a selector keeps more metrics than its name-filtered reads cover", () => {
		const catalog = Arr.makeBy(2_101, (i) => ({
			metricName: `m_${i}`,
			metricType: "gauge",
			unit: "",
			isMonotonic: 0,
		}))
		const { layer } = recordingWarehouse(catalog)
		return Effect.gen(function* () {
			const service = yield* PromqlQueryService
			const omitted = yield* service.series(tenant, {
				...window,
				matches: ['{__name__=~"m_.*", __name__!="m_0"}'],
			})
			expect(omitted.warnings).toEqual(["results truncated due to limit"])
			// Every metric of the table reads unfiltered, so nothing is left out.
			const all = yield* service.series(tenant, { ...window, matches: ['{__name__=~"m_.*"}'] })
			expect(all.warnings).toEqual([])
		}).pipe(Effect.provide(layer))
	})

	it.effect("warns when a discovery limit cut the answer, as Prometheus does", () => {
		const { layer } = recordingWarehouse()
		return Effect.gen(function* () {
			const service = yield* PromqlQueryService
			const match = { ...window, matches: ['http_requests_total{http_route=~"/c.*"}'] }
			const all = yield* service.series(tenant, match)
			expect(all.warnings).toEqual([])
			const cut = yield* service.series(tenant, { ...match, limit: 1 })
			expect(cut.data).toHaveLength(1)
			expect(cut.warnings).toEqual(["results truncated due to limit"])
			const jobs = yield* service.labelValues(tenant, { ...window, matches: [], name: "job", limit: 1 })
			expect(jobs).toEqual({ data: ["api"], warnings: ["results truncated due to limit"] })
			const names = yield* service.labelNames(tenant, { ...window, matches: [], limit: 2 })
			expect(names.warnings).toEqual(["results truncated due to limit"])
		}).pipe(Effect.provide(layer))
	})
})
