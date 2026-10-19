import { assert, describe, it } from "@effect/vitest"
import { MetricName, OrgId } from "@maple/domain"
import type { GcpMetricDescriptor, GcpPromQlSeries } from "@maple/domain/gcp-live-metrics"
import { QueryEngineExecuteRequest, type QueryEngineResult, type QuerySpec } from "@maple/domain/query-engine"
import { Effect } from "effect"
import type { GcpLiveMetrics } from "./live-metrics"
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

const seconds = (iso: string) => Date.parse(iso) / 1000

interface Calls {
	readonly range: Array<Parameters<GcpLiveMetrics["queryRange"]>[1]>
	readonly instant: Array<Parameters<GcpLiveMetrics["queryInstant"]>[1]>
	warehouse: number
}

const makeFakes = (answer: (query: string) => ReadonlyArray<GcpPromQlSeries> = () => []) => {
	const calls: Calls = { range: [], instant: [], warehouse: 0 }
	const gcp: GcpLiveMetrics = {
		queryRange: (_tenant, request) => {
			calls.range.push(request)
			return Effect.succeed(answer(request.query))
		},
		queryInstant: (_tenant, request) => {
			calls.instant.push(request)
			return Effect.succeed(answer(request.query))
		},
		listMetrics: () => Effect.succeed([transactions]),
		describeMetric: (_tenant, type) => Effect.succeed(type === TX ? transactions : undefined),
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

describe("Google Cloud metrics routing", () => {
	it.effect(
		"answers a Cloud Monitoring metric from Google and labels points by the bucket they close",
		() =>
			Effect.gen(function* () {
				const fakes = makeFakes(() => [
					series({ database_id: "p:main" }, [
						["2026-10-19T10:05:00Z", 4],
						["2026-10-19T10:10:00Z", 7],
					]),
					series({}, [["2026-10-19T10:10:00Z", 1]]),
				])

				const response = yield* execute(
					fakes,
					timeseries({
						groupBy: ["attribute"],
						filters: { ...metricFilters(TX), groupByAttributeKey: "database_id" },
					}),
				)

				assert.strictEqual(fakes.calls.warehouse, 0)
				assert.deepStrictEqual(fakes.calls.range, [
					{
						query: `sum by (database_id) (sum_over_time({"${TX}", monitored_resource="cloudsql_database"}[300s]))`,
						startSeconds: seconds("2026-10-19T10:05:00Z"),
						endSeconds: seconds("2026-10-19T10:20:00Z"),
						stepSeconds: 300,
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
			const fakes = makeFakes(() => [series({}, [["2026-10-19T10:05:00Z", 3]])])
			const response = yield* execute(fakes, timeseries({ groupBy: ["service"] }))
			assert.deepStrictEqual(dataOf(response, "timeseries")[0], {
				bucket: "2026-10-19T10:00:00.000Z",
				series: { all: 3 },
			})
			assert.notInclude(fakes.calls.range[0]?.query ?? "", " by ")
		}),
	)

	it.effect("caps a grouped series to the highest peaks", () =>
		Effect.gen(function* () {
			const fakes = makeFakes(() => [
				series({ database_id: "low" }, [["2026-10-19T10:05:00Z", 1]]),
				series({ database_id: "high" }, [["2026-10-19T10:05:00Z", 9]]),
				series({ database_id: "mid" }, [["2026-10-19T10:10:00Z", 5]]),
			])
			const response = yield* execute(
				fakes,
				timeseries({
					groupBy: ["attribute"],
					filters: { ...metricFilters(TX), groupByAttributeKey: "database_id" },
					seriesLimit: 2,
				}),
			)
			const names = new Set(
				dataOf(response, "timeseries").flatMap((point) => Object.keys(point.series)),
			)
			assert.deepStrictEqual([...names].sort(), ["high", "mid"])
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
			assert.strictEqual(error._tag, "@maple/http/errors/GcpLiveQueryUnavailableError")
		}),
	)

	it.effect("narrows the fan-out to the filtered projects", () =>
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
			assert.deepStrictEqual(fakes.calls.range[0]?.projects, ["alpha"])
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

	it.effect("ranks groups from one instant query over the whole range", () =>
		Effect.gen(function* () {
			const fakes = makeFakes(() => [
				series({ database_id: "a" }, [["2026-10-19T10:15:00Z", 2]]),
				series({ database_id: "b" }, [["2026-10-19T10:15:00Z", 5]]),
				series({ database_id: "c" }, [["2026-10-19T10:15:00Z", 1]]),
			])
			const response = yield* execute(fakes, breakdown({ limit: 2 }))
			assert.deepStrictEqual(fakes.calls.instant, [
				{
					query: `sum by (database_id) (sum_over_time({"${TX}", monitored_resource="cloudsql_database"}[900s])) / 900`,
					timeSeconds: seconds("2026-10-19T10:15:00Z"),
				},
			])
			assert.deepStrictEqual(dataOf(response, "breakdown"), [
				{ name: "b", value: 5 },
				{ name: "a", value: 2 },
			])
		}),
	)

	it.effect("asks for a label group instead of service", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(execute(makeFakes(), breakdown({ groupBy: "service" })))
			assert.strictEqual(error._tag, "@maple/http/errors/QueryEngineValidationError")
		}),
	)
})

describe("Google Cloud metric discovery", () => {
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

	it.effect("lists a label's values with their series counts", () =>
		Effect.gen(function* () {
			const fakes = makeFakes(() => [
				series({ database_id: "a" }, [["2026-10-19T10:15:00Z", 1]]),
				series({ database_id: "b" }, [["2026-10-19T10:15:00Z", 3]]),
				series({}, [["2026-10-19T10:15:00Z", 9]]),
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
				`count by (database_id) (last_over_time({"${TX}", monitored_resource="cloudsql_database"}[900s]))`,
			)
			assert.deepStrictEqual(dataOf(response, "attributeValues"), [
				{ value: "b", count: 3 },
				{ value: "a", count: 1 },
			])
		}),
	)

	it.effect("leaves Google Cloud metrics out of the warehouse sparklines read", () =>
		Effect.gen(function* () {
			const fakes = makeFakes()
			const response = yield* execute(fakes, {
				kind: "sparklines",
				source: "metrics",
				metricType: "sum",
				metricNames: [MetricName.make(TX)],
			})
			assert.strictEqual(fakes.calls.warehouse, 0)
			assert.deepStrictEqual(dataOf(response, "sparklines"), [{ metricName: TX, points: [] }])
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
			? [series({ database_id: "a" }, [["2026-10-19T10:05:00Z", 5]])]
			: [
					series({ database_id: "a" }, [["2026-10-19T10:05:00Z", 42]]),
					series({ database_id: "b" }, [["2026-10-19T10:05:00Z", 7]]),
				]
	const grouped = timeseries({
		groupBy: ["attribute"],
		filters: { ...metricFilters(TX), groupByAttributeKey: "database_id" },
		bucketSeconds: 60,
	})

	it.effect("evaluates the window as one instant query per group, with sample counts", () =>
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
						`sum by (database_id) (sum_over_time({"${TX}", monitored_resource="cloudsql_database"}[300s]))`,
						seconds("2026-10-19T10:05:00Z"),
					],
					[
						`sum by (database_id) (count_over_time({"${TX}", monitored_resource="cloudsql_database"}[300s]))`,
						seconds("2026-10-19T10:05:00Z"),
					],
				],
			)
			assert.deepStrictEqual(result, [
				{ groupKey: "a", value: 42, sampleCount: 5, hasData: true },
				{ groupKey: "b", value: null, sampleCount: 0, hasData: false },
			])
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
			assert.strictEqual(error._tag, "@maple/http/errors/GcpLiveQueryUnavailableError")
		}),
	)
})
