import { assert, describe, it } from "@effect/vitest"
import { DeploymentEnvironment, MetricName, OrgId } from "@maple/domain"
import { Effect } from "effect"
import { compiledQueryOf } from "../execution/compiled-input"
import type { MetricsTimeseriesQuery } from "@maple/domain/query-engine"
import {
	makeQueryEngineEvaluateSeries,
	type AlertEvaluateRequest,
	type QueryEngineWarehouse,
} from "./query-engine"

const tenant = { orgId: OrgId.make("org_metrics_alert_test") }

const makeRequest = (query: MetricsTimeseriesQuery): AlertEvaluateRequest => ({
	startTime: "2026-04-01 00:00:00",
	endTime: "2026-04-01 01:00:00",
	source: { kind: "spec", query },
	reducer: "identity",
	sampleCountStrategy: "metric_data_points",
})

const makeWarehouse = (
	rows: ReadonlyArray<Record<string, unknown>>,
	onCompiled: (sql: string, context: string | undefined) => void = () => undefined,
): QueryEngineWarehouse => ({
	rawSqlQuery: () => Effect.die("unexpected rawSqlQuery"),
	compiledQuery(_tenant, compiled, options) {
		onCompiled(compiledQueryOf(compiled).sql, options?.context)
		return Effect.succeed(rows as ReadonlyArray<never>)
	},
	compiledQueryWithCapabilities: () => Effect.die("unexpected capability-aware query"),
})

const baseFilters = {
	metricName: MetricName.make("http.requests"),
	metricType: "sum" as const,
}

describe("metric alert evaluation", () => {
	it.effect("lowers environments and preserves regular aggregate sample counts", () =>
		Effect.gen(function* () {
			let sql = ""
			let context: string | undefined
			const warehouse = makeWarehouse(
				[
					{ bucket: "2026-04-01 00:00:00", groupName: "", value: 12, dataPointCount: 4, seriesCount: 2 },
				],
				(compiledSql, compiledContext) => {
					sql = compiledSql
					context = compiledContext
				},
			)

			const result = yield* makeQueryEngineEvaluateSeries(warehouse)(
				tenant,
				makeRequest({
					kind: "timeseries",
					source: "metrics",
					metric: "sum",
					filters: {
						...baseFilters,
						environments: [DeploymentEnvironment.make("production")],
					},
					bucketSeconds: 3600,
				}),
			)

			assert.include(sql, "OrgId = 'org_metrics_alert_test'")
			assert.include(
				sql,
				"coalesce(nullIf(metrics_sum.ResourceAttributes['deployment.environment.name'], ''), metrics_sum.ResourceAttributes['deployment.environment']) IN ('production')",
			)
			assert.strictEqual(context, "metricsAlertEval")
			assert.deepStrictEqual(result, [
				{
					bucket: "2026-04-01T00:00:00.000Z",
					groupKey: "all",
					value: 12,
					sampleCount: 4,
				},
			])
		}),
	)

	for (const [metric, expectedValue] of [
		["rate", 2.5],
		["increase", 10],
	] as const) {
		it.effect(`evaluates ${metric} rows with metric data-point sample counts`, () =>
			Effect.gen(function* () {
				let sql = ""
				let context: string | undefined
				const warehouse = makeWarehouse(
					[
						{
							bucket: "2026-04-01 00:00:00",
							groupName: "",
							value: expectedValue,
							dataPointCount: 4,
							seriesCount: 1,
						},
					],
					(compiledSql, compiledContext) => {
						sql = compiledSql
						context = compiledContext
					},
				)

				const result = yield* makeQueryEngineEvaluateSeries(warehouse)(
					tenant,
					makeRequest({
						kind: "timeseries",
						source: "metrics",
						metric,
						filters: baseFilters,
						bucketSeconds: 3600,
					}),
				)

				assert.strictEqual(context, "metricsRateIncreaseAlertEval")
				// Only a rate divides the increase by the covered seconds.
				assert.strictEqual(sql.includes("sum(per_series.increase) / min("), metric === "rate")
				assert.strictEqual(result[0]?.value, expectedValue)
				assert.strictEqual(result[0]?.sampleCount, 4)
			}),
		)
	}
})
