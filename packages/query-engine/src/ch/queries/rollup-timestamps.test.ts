import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect } from "effect"
import { compile, type CompiledQuery } from "@maple-dev/effect-orm/clickhouse"
import { OrgId } from "@maple/domain"
import { anomalyLogVolumeQuery, anomalyTraceSignalTimeseriesQuery } from "./anomaly"
import { serviceLivenessQuery } from "./liveness"
import { listMetricsQuery } from "./metrics"
import { releasesListQuery, releasesTimelineQuery, serviceDeploymentsQuery } from "./releases"
import {
	routeUsageQuery,
	serviceOperationsTimeseriesQuery,
	serviceOperationsTimeseriesRawQuery,
} from "./service-operations"
import { dbQueryVolumeQuery, serviceDbQueryTimeseriesSQL, serviceDbTopQueriesSQL } from "./service-map"
import { serviceMapEdgesRollupSQL } from "./service-map-rollup"
import { serviceApdexTimeseriesQuery, serviceOverviewQuery, serviceReleasesTimelineQuery } from "./services"
import { tracesTimeseriesQuery } from "./traces"

// Rows reach callers through `decodeRows`. A query whose row schema is not
// derived passes rows through untouched, and its rollup timestamps would stay
// strings behind a `DateTime.Utc` type.

const orgId = OrgId.make("org_1")
const params = {
	orgId,
	startTime: "2026-10-07 10:00:00",
	endTime: "2026-10-07 14:00:00",
	bucketSeconds: 3600,
	serviceName: "api",
	deploymentEnv: "production",
}
const WIRE = "2026-10-07 11:00:00"
const ISO = "2026-10-07T11:00:00.000Z"

/** Decodes one row with every listed field set to the wire timestamp. */
const decodeTimes = <Row>(compiled: CompiledQuery<Row>, fields: ReadonlyArray<keyof Row & string>) =>
	Effect.gen(function* () {
		expect(compiled.rowSchemaSource).not.toBe("none")
		const [row] = yield* compiled.decodeRows([sampleRow(fields)])
		return row
	})

const sampleRow = (fields: ReadonlyArray<string>): Record<string, unknown> => ({
	...Object.fromEntries(fields.map((field) => [field, WIRE])),
	serviceName: "api",
	serviceNamespace: "",
	environment: "production",
	deploymentEnv: "production",
	commitSha: "abc",
	spanName: "GET /",
	metricName: "m",
	metricType: "sum",
	metricDescription: "",
	metricUnit: "",
	isMonotonic: 1,
	dbSystem: "postgresql",
	dbNamespace: "",
	queryKey: "k",
	queryLabel: "SELECT",
	sampleStatement: "",
	sampleService: "api",
	count: 1,
	spanCount: 1,
	errorCount: 0,
	totalCount: 1,
	satisfiedCount: 1,
	toleratingCount: 0,
	apdexScore: 1,
	queryCount: 1,
	estimatedQueryCount: 1,
	estimatedSpanCount: 1,
	estimatedErrorCount: 0,
	errorRate: 0,
	avgDurationMs: 1,
	p50DurationMs: 1,
	p95DurationMs: 1,
	p50LatencyMs: 1,
	p95LatencyMs: 1,
	p99LatencyMs: 1,
	apdexSatisfiedCount: 1,
	apdexToleratingCount: 0,
	serviceCount: 1,
	dataPointCount: 1,
	minutesWithData: 1,
	requestCount: 1,
	p95Ms: 1,
	errorLogCount: 0,
	warnLogCount: 0,
	throughput: 1,
	commits: [["abc", 1, 0, WIRE]],
})

const iso = (value: DateTime.Utc) => DateTime.formatIso(value)

describe("rollup timestamps decode to DateTime.Utc", () => {
	it.effect("services", () =>
		Effect.gen(function* () {
			const overview = yield* decodeTimes(yield* compile(serviceOverviewQuery({}), params), [
				"firstSeen",
			])
			expect(iso(overview!.firstSeen)).toBe(ISO)
			expect(iso(overview!.commits[0]![3])).toBe(ISO)
			for (const bucketSeconds of [30, 300, 3600]) {
				const p = { ...params, bucketSeconds }
				const apdex = yield* decodeTimes(
					yield* compile(serviceApdexTimeseriesQuery({ serviceName: "api", bucketSeconds }), p),
					["bucket"],
				)
				expect(iso(apdex!.bucket)).toBe(ISO)
				const releases = yield* decodeTimes(
					yield* compile(serviceReleasesTimelineQuery({ serviceName: "api", bucketSeconds }), p),
					["bucket"],
				)
				expect(iso(releases!.bucket)).toBe(ISO)
			}
		}),
	)

	it.effect("releases", () =>
		Effect.gen(function* () {
			const list = yield* decodeTimes(yield* compile(releasesListQuery(), params), ["firstSeen"])
			expect(iso(list!.firstSeen)).toBe(ISO)
			const timeline = yield* decodeTimes(
				yield* compile(releasesTimelineQuery({ bucketSeconds: 3600 }), params),
				["bucket"],
			)
			expect(iso(timeline!.bucket)).toBe(ISO)
			const deployments = yield* decodeTimes(
				yield* compile(serviceDeploymentsQuery({ minutePrecision: true }), params),
				["firstSeen", "lastSeen"],
			)
			expect(iso(deployments!.lastSeen)).toBe(ISO)
		}),
	)

	it.effect("service operations and routes", () =>
		Effect.gen(function* () {
			const opts = { serviceName: "api", spanNames: ["GET /"], bucketSeconds: 3600 }
			const spliced = yield* decodeTimes(
				yield* compile(serviceOperationsTimeseriesQuery(opts), params),
				["bucket"],
			)
			expect(iso(spliced!.bucket)).toBe(ISO)
			const raw = yield* decodeTimes(
				yield* compile(serviceOperationsTimeseriesRawQuery(opts), params),
				["bucket"],
			)
			expect(iso(raw!.bucket)).toBe(ISO)
			const routes = yield* decodeTimes(yield* compile(routeUsageQuery({}), params), [
				"firstSeen",
				"lastSeen",
			])
			expect(iso(routes!.firstSeen)).toBe(ISO)
		}),
	)

	it.effect("service map database drill-downs", () =>
		Effect.gen(function* () {
			for (const bucketSeconds of [300, 3600]) {
				const ts = yield* decodeTimes(
					yield* serviceDbQueryTimeseriesSQL({ ...params, dbSystem: "postgresql", bucketSeconds }),
					["bucket"],
				)
				expect(iso(ts!.bucket)).toBe(ISO)
			}
			const top = yield* decodeTimes(
				yield* serviceDbTopQueriesSQL({ ...params, dbSystem: "postgresql" }),
				["lastSeen"],
			)
			expect(iso(top!.lastSeen)).toBe(ISO)
			const volume = yield* decodeTimes(yield* compile(dbQueryVolumeQuery({}), params), ["lastSeen"])
			expect(iso(volume!.lastSeen)).toBe(ISO)
		}),
	)

	it.effect("metric catalog, liveness and anomaly signals", () =>
		Effect.gen(function* () {
			const metrics = yield* decodeTimes(yield* compile(listMetricsQuery({}), params), [
				"firstSeen",
				"lastSeen",
			])
			expect(iso(metrics!.lastSeen)).toBe(ISO)
			const liveness = yield* decodeTimes(yield* compile(serviceLivenessQuery(), params), ["lastSeen"])
			expect(iso(liveness!.lastSeen)).toBe(ISO)
			const trace = yield* decodeTimes(yield* compile(anomalyTraceSignalTimeseriesQuery(), params), [
				"hour",
			])
			expect(iso(trace!.hour)).toBe(ISO)
			const logs = yield* decodeTimes(
				yield* compile(anomalyLogVolumeQuery({ hoursOfDay: [11] }), params),
				["hour"],
			)
			expect(iso(logs!.hour)).toBe(ISO)
		}),
	)

	// These stay the wire string: the rollup ingests its rows unchanged, and the
	// traces timeseries endpoint's raw path still returns strings.
	it.effect("write path and shared timeseries keep the wire string", () =>
		Effect.gen(function* () {
			const rollup = yield* serviceMapEdgesRollupSQL({
				orgId,
				hourStart: "2026-10-07 10:00:00",
				hourEnd: "2026-10-07 11:00:00",
			})
			const [edge] = yield* rollup.decodeRows([
				{
					OrgId: "org_1",
					Hour: WIRE,
					SourceService: "a",
					TargetService: "b",
					DeploymentEnv: "",
					CallCount: 1,
					ErrorCount: 0,
					DurationSumMs: 1,
					MaxDurationMs: 1,
					SampledSpanCount: 0,
					UnsampledSpanCount: 1,
					SampleRateSum: 1,
				},
			])
			expect(edge!.Hour).toBe(WIRE)

			const annual = yield* compile(
				tracesTimeseriesQuery({
					metric: "count",
					bucketSeconds: 86_400,
					serviceName: "api",
					needsSampling: false,
				}),
				{ ...params, bucketSeconds: 86_400 },
			)
			expect(annual.rowSchemaSource).not.toBe("none")
		}),
	)
})
