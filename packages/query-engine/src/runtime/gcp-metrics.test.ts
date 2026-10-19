import { assert, describe, it } from "@effect/vitest"
import { MetricName, OrgId } from "@maple/domain"
import type { GcpMetricDescriptor, GcpPromQlSeries } from "@maple/domain/gcp-live-metrics"
import { GcpLiveQueryUnavailableError } from "@maple/domain/http/gcp-live-query-errors"
import { QueryEngineValidationError } from "@maple/domain/http"
import { QueryEngineExecuteRequest, type QueryEngineResult, type QuerySpec } from "@maple/domain/query-engine"
import { Effect } from "effect"
import type { GcpLiveMetrics, GcpReadScope } from "./live-metrics"
import {
	makeQueryEngineEvaluate,
	makeQueryEngineEvaluateSeries,
	makeQueryEngineExecute,
	type AlertEvaluateRequest,
	type QueryEngineWarehouse,
} from "./query-engine"

const tenant = { orgId: OrgId.make("org_gcp_live_test") }

const TX = "cloudsql.googleapis.com/database/postgresql/transaction_count"
const transactions: GcpMetricDescriptor = {
	type: TX,
	metricKind: "DELTA",
	valueType: "INT64",
	unit: "1",
	description: "",
	monitoredResourceTypes: ["cloudsql_database"],
	labels: ["transaction_type"],
}
const LAT = "serviceruntime.googleapis.com/api/request_latencies"
const latencies: GcpMetricDescriptor = {
	...transactions,
	type: LAT,
	valueType: "DISTRIBUTION",
	monitoredResourceTypes: ["consumed_api"],
	labels: [],
}
const SELECTOR = `{"${TX}", monitored_resource="cloudsql_database"}`

const seconds = (iso: string) => Date.parse(iso) / 1000

interface Calls {
	readonly range: Array<Parameters<GcpLiveMetrics["queryRange"]>[1]>
	readonly instant: Array<Parameters<GcpLiveMetrics["queryInstant"]>[1]>
	readonly listed: Array<GcpReadScope>
	warehouse: number
}

const makeFakes = (answer: (query: string) => ReadonlyArray<GcpPromQlSeries> = () => []) => {
	const calls: Calls = { range: [], instant: [], listed: [], warehouse: 0 }
	const gcp: GcpLiveMetrics = {
		queryRange: (_tenant, request) => {
			calls.range.push(request)
			return Effect.succeed(answer(request.query))
		},
		queryInstant: (_tenant, request) => {
			calls.instant.push(request)
			return Effect.succeed(answer(request.query))
		},
		listMetrics: (_tenant, request) => {
			calls.listed.push(request)
			return Effect.succeed([transactions, latencies])
		},
	}
	const warehouse: QueryEngineWarehouse = {
		rawSqlQuery: () => Effect.die("unexpected rawSqlQuery"),
		compiledQuery: () => {
			calls.warehouse++
			return Effect.succeed([])
		},
		compiledQueryWithCapabilities: () => Effect.die("unexpected capability-aware query"),
	}
	return { calls, gcp, warehouse }
}

const series = (labels: Record<string, string>, points: ReadonlyArray<readonly [string, number]>) => ({
	labels,
	points: points.map(([iso, value]) => [seconds(iso), value] as const),
})

const execute = (
	fakes: { readonly warehouse: QueryEngineWarehouse; readonly gcp?: GcpLiveMetrics },
	query: QuerySpec,
) =>
	makeQueryEngineExecute(fakes.warehouse, fakes.gcp)(
		tenant,
		new QueryEngineExecuteRequest({
			startTime: "2026-10-19 10:00:00",
			endTime: "2026-10-19 10:15:00",
			query,
		}),
	)

const dataOf = <Kind extends QueryEngineResult["kind"]>(
	response: { readonly result: QueryEngineResult },
	kind: Kind,
): Extract<QueryEngineResult, { kind: Kind }>["data"] =>
	response.result.kind === kind
		? (response.result as Extract<QueryEngineResult, { kind: Kind }>).data
		: assert.fail(`expected a ${kind} result, got ${response.result.kind}`)

const metricFilters = (metricName: string) => ({
	metricName: MetricName.make(metricName),
	metricType: "sum" as const,
})

const timeseries = (overrides: Partial<Extract<QuerySpec, { kind: "timeseries"; source: "metrics" }>> = {}) =>
	({
		kind: "timeseries",
		source: "metrics",
		metric: "sum",
		filters: metricFilters(TX),
		bucketSeconds: 300,
		...overrides,
	}) satisfies QuerySpec

const byDatabase = (overrides: Partial<Extract<QuerySpec, { kind: "timeseries"; source: "metrics" }>> = {}) =>
	timeseries({
		groupBy: ["attribute"],
		filters: { ...metricFilters(TX), groupByAttributeKey: "database_id" },
		...overrides,
	})

describe("Google Cloud metrics routing", () => {
	it.effect(
		"answers a Cloud Monitoring metric from Google and labels points by the bucket they close",
		() =>
			Effect.gen(function* () {
				const fakes = makeFakes(() => [
					series({ database_id: "p:main", project_id: "alpha" }, [
						["2026-10-19T10:05:00Z", 4],
						["2026-10-19T10:10:00Z", 7],
					]),
					series({ project_id: "alpha" }, [["2026-10-19T10:10:00Z", 1]]),
				])

				const response = yield* execute(fakes, byDatabase())

				assert.strictEqual(fakes.calls.warehouse, 0)
				assert.deepStrictEqual(fakes.calls.range, [
					{
						query: `sum by (database_id, project_id) (sum_over_time(${SELECTOR}[300s]))`,
						startSeconds: seconds("2026-10-19T10:05:00Z"),
						endSeconds: seconds("2026-10-19T10:20:00Z"),
						stepSeconds: 300,
						projects: undefined,
						requireComplete: undefined,
						discovery: undefined,
					},
				])
				assert.deepStrictEqual(dataOf(response, "timeseries"), [
					{ bucket: "2026-10-19T10:00:00.000Z", series: { "p:main": 4 } },
					{ bucket: "2026-10-19T10:05:00.000Z", series: { "p:main": 7, "(empty)": 1 } },
					{ bucket: "2026-10-19T10:10:00.000Z", series: {} },
					{ bucket: "2026-10-19T10:15:00.000Z", series: {} },
				])
			}),
	)

	it.effect("keeps every other metric on the warehouse", () =>
		Effect.gen(function* () {
			const fakes = makeFakes()
			yield* execute(fakes, timeseries({ filters: metricFilters("http.server.duration") }))
			assert.strictEqual(fakes.calls.warehouse, 1)
			assert.strictEqual(fakes.calls.range.length, 0)
		}),
	)

	it.effect("returns one ungrouped series, ignoring a service group-by", () =>
		Effect.gen(function* () {
			const fakes = makeFakes(() => [series({ project_id: "alpha" }, [["2026-10-19T10:05:00Z", 3]])])
			const response = yield* execute(fakes, timeseries({ groupBy: ["service"] }))
			assert.deepStrictEqual(dataOf(response, "timeseries")[0], {
				bucket: "2026-10-19T10:00:00.000Z",
				series: { all: 3 },
			})
			assert.include(fakes.calls.range[0]?.query ?? "", "sum by (project_id) (")
		}),
	)

	it.effect("sums a group across projects, and reads a project two metrics scopes answer once", () =>
		Effect.gen(function* () {
			const fakes = makeFakes(() => [
				series({ database_id: "main", project_id: "alpha" }, [["2026-10-19T10:05:00Z", 4]]),
				series({ database_id: "main", project_id: "beta" }, [["2026-10-19T10:05:00Z", 3]]),
				// beta again, from a second scope that also monitors it.
				series({ project_id: "beta", database_id: "main" }, [["2026-10-19T10:05:00Z", 3]]),
				series({ database_id: "replica", project_id: "beta" }, [["2026-10-19T10:05:00Z", 1]]),
			])
			const response = yield* execute(fakes, byDatabase())
			assert.deepStrictEqual(dataOf(response, "timeseries")[0], {
				bucket: "2026-10-19T10:00:00.000Z",
				series: { main: 7, replica: 1 },
			})
		}),
	)

	it.effect("merges min, max and avg across projects by their own reducer", () =>
		Effect.gen(function* () {
			const at = (value: number) => [["2026-10-19T10:05:00Z", value]] as const
			const merged = (metric: "min" | "max" | "avg", answer: ReadonlyArray<GcpPromQlSeries>) =>
				execute(
					makeFakes(() => answer),
					timeseries({ metric }),
				).pipe(Effect.map((response) => dataOf(response, "timeseries")[0]?.series))

			const extremes = [
				series({ project_id: "alpha" }, at(4)),
				series({ project_id: "beta" }, at(9)),
				series({ project_id: "gamma" }, at(2)),
			]
			assert.deepStrictEqual(yield* merged("min", extremes), { all: 2 })
			assert.deepStrictEqual(yield* merged("max", extremes), { all: 9 })
			// alpha averages 4 over 2 series, beta 2 over 1: 6 / 3, not the mean of 2 and 2.
			assert.deepStrictEqual(
				yield* merged("avg", [
					series({ project_id: "alpha", maple_part: "sum" }, at(4)),
					series({ project_id: "alpha", maple_part: "count" }, at(2)),
					series({ project_id: "beta", maple_part: "sum" }, at(2)),
					series({ project_id: "beta", maple_part: "count" }, at(1)),
				]),
				{ all: 2 },
			)
		}),
	)

	it.effect("caps the merged groups to the highest peaks", () =>
		Effect.gen(function* () {
			const fakes = makeFakes(() => [
				series({ database_id: "low", project_id: "alpha" }, [["2026-10-19T10:05:00Z", 6]]),
				// Highest across projects only once alpha and beta are summed.
				series({ database_id: "split", project_id: "alpha" }, [["2026-10-19T10:05:00Z", 5]]),
				series({ database_id: "split", project_id: "beta" }, [["2026-10-19T10:05:00Z", 5]]),
				series({ database_id: "mid", project_id: "beta" }, [["2026-10-19T10:10:00Z", 7]]),
			])
			const response = yield* execute(fakes, byDatabase({ seriesLimit: 2 }))
			const names = new Set(
				dataOf(response, "timeseries").flatMap((point) => Object.keys(point.series)),
			)
			assert.deepStrictEqual([...names].sort(), ["mid", "split"])
		}),
	)

	it.effect("reads an unknown metric as no data, with every bucket still present", () =>
		Effect.gen(function* () {
			const fakes = makeFakes()
			const response = yield* execute(
				fakes,
				timeseries({ filters: metricFilters("cloudsql.googleapis.com/database/never_reported") }),
			)
			assert.strictEqual(fakes.calls.range.length, 0)
			const data = dataOf(response, "timeseries")
			assert.strictEqual(data.length, 4)
			assert.isTrue(data.every((point) => Object.keys(point.series).length === 0))
		}),
	)

	it.effect("fails as unavailable when the deployment has no Google port", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(execute({ warehouse: makeFakes().warehouse }, timeseries()))
			assert.instanceOf(error, GcpLiveQueryUnavailableError)
			assert.strictEqual(
				error.message,
				"Google Cloud metrics are not available on this Maple deployment.",
			)
		}),
	)

	it.effect("narrows the metric listing and the query to the filtered projects", () =>
		Effect.gen(function* () {
			const fakes = makeFakes()
			yield* execute(
				fakes,
				timeseries({
					filters: {
						...metricFilters(TX),
						resourceAttributeFilters: [{ key: "project_id", mode: "equals", value: "alpha" }],
					},
				}),
			)
			// A chart lists with the query's own project selection, never discovery's first 20.
			assert.deepStrictEqual(fakes.calls.listed, [
				{ projects: ["alpha"], requireComplete: undefined, discovery: undefined },
			])
			assert.deepStrictEqual(fakes.calls.range[0]?.projects, ["alpha"])
			assert.include(fakes.calls.range[0]?.query ?? "", `project_id="alpha"`)
		}),
	)

	it.effect("says why a query is refused in the message", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				execute(
					makeFakes(),
					timeseries({
						filters: {
							...metricFilters(TX),
							attributeFilters: [{ key: "database_id", mode: "in", values: [] }],
						},
					}),
				),
			)
			assert.instanceOf(error, QueryEngineValidationError)
			assert.include(error.message, "database_id")
		}),
	)
})

describe("Google Cloud metrics breakdown", () => {
	const breakdown = (
		overrides: Partial<Extract<QuerySpec, { kind: "breakdown"; source: "metrics" }>> = {},
	) =>
		({
			kind: "breakdown",
			source: "metrics",
			metric: "rate",
			groupBy: "attribute",
			filters: { ...metricFilters(TX), groupByAttributeKey: "database_id" },
			...overrides,
		}) satisfies QuerySpec

	it.effect("ranks groups, summed across projects, from one instant query over the whole range", () =>
		Effect.gen(function* () {
			const fakes = makeFakes(() => [
				series({ database_id: "a", project_id: "alpha" }, [["2026-10-19T10:15:00Z", 2]]),
				series({ database_id: "a", project_id: "beta" }, [["2026-10-19T10:15:00Z", 4]]),
				series({ database_id: "b", project_id: "alpha" }, [["2026-10-19T10:15:00Z", 5]]),
				series({ database_id: "c", project_id: "alpha" }, [["2026-10-19T10:15:00Z", 1]]),
			])
			const response = yield* execute(fakes, breakdown({ limit: 2 }))
			assert.deepStrictEqual(fakes.calls.instant, [
				{
					query: `sum by (database_id, project_id) (sum_over_time(${SELECTOR}[900s])) / 900`,
					timeSeconds: seconds("2026-10-19T10:15:00Z"),
					projects: undefined,
					requireComplete: undefined,
					discovery: undefined,
				},
			])
			assert.deepStrictEqual(dataOf(response, "breakdown"), [
				{ name: "a", value: 6 },
				{ name: "b", value: 5 },
			])
		}),
	)

	it.effect("asks for a label group instead of service", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(execute(makeFakes(), breakdown({ groupBy: "service" })))
			assert.instanceOf(error, QueryEngineValidationError)
			assert.include(error.message, "no service.name")
		}),
	)
})

const ENTRIES = "logging.googleapis.com/log_entry_count"
const entries: GcpMetricDescriptor = {
	...transactions,
	type: ENTRIES,
	monitoredResourceTypes: [],
	labels: ["severity", "log"],
}

describe("Google Cloud metric discovery", () => {
	it.effect("reads labels as discovery: the first 20 projects past the cap, not a refusal", () =>
		Effect.gen(function* () {
			const fakes = makeFakes()
			yield* execute(fakes, { kind: "attributeKeys", source: "metrics", metricName: TX })
			yield* execute(fakes, {
				kind: "attributeValues",
				source: "metrics",
				scope: "metric",
				attributeKey: "database_id",
				metricName: TX,
			})
			assert.isTrue(
				[...fakes.calls.listed, ...fakes.calls.instant].every((call) => call.discovery === true),
			)
		}),
	)

	it.effect("lists a metric without resource types by its labels, without reading Google", () =>
		Effect.gen(function* () {
			const fakes = makeFakes()
			const gcp: GcpLiveMetrics = { ...fakes.gcp, listMetrics: () => Effect.succeed([entries]) }
			const keys = yield* execute(
				{ warehouse: fakes.warehouse, gcp },
				{ kind: "attributeKeys", source: "metrics", metricName: ENTRIES },
			)
			assert.deepStrictEqual(
				dataOf(keys, "attributeKeys").map((item) => item.key),
				["log", "monitored_resource", "project_id", "severity"],
			)
			const values = yield* execute(
				{ warehouse: fakes.warehouse, gcp },
				{
					kind: "attributeValues",
					source: "metrics",
					scope: "metric",
					attributeKey: "severity",
					metricName: ENTRIES,
				},
			)
			assert.deepStrictEqual(dataOf(values, "attributeValues"), [])
			assert.lengthOf(fakes.calls.instant, 0)

			// A chart still asks for the resource type.
			const chart = yield* Effect.flip(
				execute({ warehouse: fakes.warehouse, gcp }, timeseries({ filters: metricFilters(ENTRIES) })),
			)
			assert.instanceOf(chart, QueryEngineValidationError)
			assert.include(chart.message, "filter on monitored_resource")
		}),
	)

	it.effect("lists the descriptor's labels and the labels seen on recent series", () =>
		Effect.gen(function* () {
			const fakes = makeFakes(() => [
				series(
					{ __name__: TX, project_id: "alpha", database_id: "a", transaction_type: "commit" },
					[],
				),
				series({ __name__: TX, project_id: "alpha", database_id: "b" }, []),
			])
			const all = yield* execute(fakes, { kind: "attributeKeys", source: "metrics", metricName: TX })
			assert.deepStrictEqual(dataOf(all, "attributeKeys"), [
				{ key: "database_id", count: 2 },
				{ key: "project_id", count: 2 },
				{ key: "transaction_type", count: 1 },
			])
			const resource = yield* execute(fakes, {
				kind: "attributeKeys",
				source: "metrics",
				metricName: TX,
				scope: "resource",
			})
			assert.deepStrictEqual(
				dataOf(resource, "attributeKeys").map((item) => item.key),
				["database_id", "project_id"],
			)
		}),
	)

	it.effect("lists a label's values with their series counts summed across projects", () =>
		Effect.gen(function* () {
			const fakes = makeFakes(() => [
				series({ database_id: "a", project_id: "alpha" }, [["2026-10-19T10:15:00Z", 1]]),
				series({ database_id: "b", project_id: "alpha" }, [["2026-10-19T10:15:00Z", 1]]),
				series({ database_id: "b", project_id: "beta" }, [["2026-10-19T10:15:00Z", 2]]),
				series({ project_id: "beta" }, [["2026-10-19T10:15:00Z", 9]]),
			])
			const response = yield* execute(fakes, {
				kind: "attributeValues",
				source: "metrics",
				scope: "metric",
				attributeKey: "database_id",
				metricName: TX,
			})
			assert.strictEqual(
				fakes.calls.instant[0]?.query,
				`count by (database_id, project_id) (last_over_time(${SELECTOR}[900s]))`,
			)
			assert.deepStrictEqual(dataOf(response, "attributeValues"), [
				{ value: "b", count: 3 },
				{ value: "a", count: 1 },
			])
		}),
	)
})

describe("Google Cloud metric alerts", () => {
	const alertRequest = (query: QuerySpec): AlertEvaluateRequest => ({
		startTime: "2026-10-19 10:00:00",
		endTime: "2026-10-19 10:05:00",
		source: { kind: "spec", query },
		reducer: "identity",
		sampleCountStrategy: "metric_data_points",
	})
	const answer = (query: string) =>
		query.includes("count_over_time")
			? [
					series({ database_id: "a", project_id: "alpha" }, [["2026-10-19T10:05:00Z", 3]]),
					series({ database_id: "a", project_id: "beta" }, [["2026-10-19T10:05:00Z", 2]]),
				]
			: [
					series({ database_id: "a", project_id: "alpha" }, [["2026-10-19T10:05:00Z", 40]]),
					series({ database_id: "a", project_id: "beta" }, [["2026-10-19T10:05:00Z", 2]]),
					series({ database_id: "b", project_id: "alpha" }, [["2026-10-19T10:05:00Z", 7]]),
				]
	const grouped = byDatabase({ bucketSeconds: 60 })

	// The window's end, four minutes back: Google's ingestion delay.
	it.effect("evaluates the window as one instant query per group, merged across projects", () =>
		Effect.gen(function* () {
			const fakes = makeFakes(answer)
			const result = yield* makeQueryEngineEvaluate(fakes.warehouse, fakes.gcp)(
				tenant,
				alertRequest(grouped),
			)
			assert.deepStrictEqual(
				fakes.calls.instant.map((call) => [call.query, call.timeSeconds]),
				[
					[
						`sum by (database_id, project_id) (sum_over_time(${SELECTOR}[300s]))`,
						seconds("2026-10-19T10:01:00Z"),
					],
					[
						`sum by (database_id, project_id) (count_over_time(${SELECTOR}[300s]))`,
						seconds("2026-10-19T10:01:00Z"),
					],
				],
			)
			assert.deepStrictEqual(result, [
				{ groupKey: "a", value: 42, sampleCount: 5, hasData: true },
				{ groupKey: "b", value: null, sampleCount: 0, hasData: false },
			])
		}),
	)

	it.effect("requires every project to answer, for the listing and both queries", () =>
		Effect.gen(function* () {
			const fakes = makeFakes(answer)
			yield* makeQueryEngineEvaluate(fakes.warehouse, fakes.gcp)(tenant, alertRequest(grouped))
			yield* makeQueryEngineEvaluateSeries(fakes.warehouse, fakes.gcp)(tenant, alertRequest(grouped))
			assert.isTrue(
				[...fakes.calls.listed, ...fakes.calls.instant, ...fakes.calls.range].every(
					(call) => call.requireComplete === true,
				),
			)
			assert.lengthOf(fakes.calls.listed, 2)
		}),
	)

	it.effect("counts a distribution's samples, not its observations", () =>
		Effect.gen(function* () {
			const fakes = makeFakes(() => [])
			yield* makeQueryEngineEvaluate(fakes.warehouse, fakes.gcp)(
				tenant,
				alertRequest(timeseries({ metric: "avg", filters: metricFilters(LAT) })),
			)
			assert.strictEqual(
				fakes.calls.instant[1]?.query,
				`sum by (project_id) (count_over_time({"${LAT}_count", monitored_resource="consumed_api"}[300s]))`,
			)
		}),
	)

	it.effect("previews the alert as bucketed range queries", () =>
		Effect.gen(function* () {
			const fakes = makeFakes(answer)
			const result = yield* makeQueryEngineEvaluateSeries(fakes.warehouse, fakes.gcp)(
				tenant,
				alertRequest(grouped),
			)
			assert.strictEqual(fakes.calls.range.length, 2)
			// The preview charts what has arrived, like the chart itself: no ingestion-delay shift.
			assert.strictEqual(fakes.calls.range[0]?.endSeconds, seconds("2026-10-19T10:06:00Z"))
			assert.deepStrictEqual(result[0], {
				bucket: "2026-10-19T10:04:00.000Z",
				groupKey: "a",
				value: 42,
				sampleCount: 5,
			})
		}),
	)

	it.effect("fails as unavailable without a Google port", () =>
		Effect.gen(function* () {
			const fakes = makeFakes(answer)
			const error = yield* Effect.flip(
				makeQueryEngineEvaluate(fakes.warehouse)(tenant, alertRequest(grouped)),
			)
			assert.instanceOf(error, GcpLiveQueryUnavailableError)
		}),
	)
})
