import { assert, describe, it } from "@effect/vitest"
import {
	GcpMetricDescriptor,
	GcpMetricSearchResponse,
	GcpPromQlFailedError,
	GcpPromQlInvalidQueryError,
	GcpPromQlResult,
	GcpPromQlTooManyProjectsError,
	GcpPromQlTooManySeriesError,
	GcpPromQlUnavailableError,
	type GcpPromQlInstantRequest,
	type GcpPromQlRangeRequest,
	OrgId,
	UserId,
} from "@maple/domain/http"
import { GcpProjectId } from "@maple/domain/primitives"
import {
	GcpPromQlService,
	type GcpPromQlServiceApi,
} from "@maple/backend/services/integrations/GcpPromQlService"
import { Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { renderToolDoc } from "../lib/tool-doc"
import { registerGcpPromQlTools, starterQuery } from "./gcp-promql"
import type { McpToolError, McpToolRegistrar } from "./types"

interface Answer {
	readonly text: string
	readonly structured: Readonly<Record<string, unknown>>
}

type Run = (
	params: Readonly<Record<string, unknown>>,
) => Effect.Effect<Answer, McpToolError | Schema.SchemaError, CurrentMcpTenant | GcpPromQlService>

/** Decode, handle, encode and render, as the registry does. */
const tools = new Map<string, Run>()
registerGcpPromQlTools({
	define: (spec) => {
		const run = (params: Readonly<Record<string, unknown>>) =>
			Schema.decodeUnknownEffect(spec.parameters)(params).pipe(
				Effect.flatMap(spec.handler),
				Effect.map((output) => ({
					text: renderToolDoc(spec.render(output)),
					structured: Schema.encodeUnknownSync(spec.output)(output) as Answer["structured"],
				})),
			)
		tools.set(spec.name, run as Run)
	},
} satisfies McpToolRegistrar)

const orgId = Schema.decodeUnknownSync(OrgId)("org_gcp")
const project = Schema.decodeUnknownSync(GcpProjectId)("shop-prod")
const NOW = Date.parse("2026-10-15T12:00:00Z")
const WINDOW = { start_time: "2026-10-15 10:00:00", end_time: "2026-10-15 12:00:00" }

const call = (
	name: string,
	params: Readonly<Record<string, unknown>>,
	service: Partial<GcpPromQlServiceApi>,
) =>
	TestClock.setTime(NOW).pipe(
		Effect.andThen(tools.get(name)!(params)),
		Effect.provide(
			Layer.mergeAll(
				Layer.succeed(CurrentMcpTenant, {
					orgId,
					userId: Schema.decodeUnknownSync(UserId)("user_gcp"),
					roles: [],
					authMode: "self_hosted",
				} as CurrentMcpTenant["Service"]),
				Layer.succeed(GcpPromQlService, service as GcpPromQlServiceApi),
			),
		),
	)

const result = (series: ReadonlyArray<{ labels: Record<string, string>; points: Array<[number, number]> }>) =>
	Schema.decodeUnknownSync(GcpPromQlResult)({
		resultType: "matrix",
		series,
		projects: ["shop-prod"],
		failures: [],
	})

describe("starterQuery", () => {
	const metric = {
		type: "run.googleapis.com/request_count",
		monitoredResourceTypes: ["cloud_run_revision"],
	}

	it("rates counters and averages gauges, aggregated so one series comes back per project", () => {
		assert.strictEqual(
			starterQuery({ ...metric, metricKind: "DELTA", valueType: "INT64" }),
			'sum(rate({"run.googleapis.com/request_count"}[5m]))',
		)
		assert.strictEqual(
			starterQuery({ ...metric, metricKind: "CUMULATIVE", valueType: "DOUBLE" }),
			'sum(rate({"run.googleapis.com/request_count"}[5m]))',
		)
		assert.strictEqual(
			starterQuery({ ...metric, metricKind: "GAUGE", valueType: "DOUBLE" }),
			'avg({"run.googleapis.com/request_count"})',
		)
	})

	it("takes a distribution's p95 and names a resource type when several are possible", () => {
		assert.strictEqual(
			starterQuery({
				type: "run.googleapis.com/request_latencies",
				metricKind: "DELTA",
				valueType: "DISTRIBUTION",
				monitoredResourceTypes: ["cloud_run_instance", "cloud_run_revision"],
			}),
			'histogram_quantile(0.95, sum by (le) (rate({"run.googleapis.com/request_latencies_bucket", monitored_resource="cloud_run_instance"}[5m])))',
		)
	})

	it("reads a gauge distribution's buckets without rate", () => {
		assert.strictEqual(
			starterQuery({ ...metric, metricKind: "GAUGE", valueType: "DISTRIBUTION" }),
			'histogram_quantile(0.95, sum by (le) ({"run.googleapis.com/request_count_bucket"}))',
		)
	})

	it("offers none for a STRING metric, which PromQL cannot read", () => {
		assert.isUndefined(starterQuery({ ...metric, metricKind: "GAUGE", valueType: "STRING" }))
	})
})

describe("query_gcp_promql", () => {
	it.effect("queries the window at a step from its width and keeps the highest series", () =>
		Effect.gen(function* () {
			const seen: Array<GcpPromQlRangeRequest> = []
			const series = Array.from({ length: 150 }, (_, index) => ({
				labels: { project_id: "shop-prod", service: `svc-${index}` },
				points: [[1_760_520_000, 1] as [number, number], [1_760_520_060, index] as [number, number]],
			}))
			const answer = yield* call(
				"query_gcp_promql",
				{ query: ' sum by (service) (rate({"run.googleapis.com/request_count"}[5m])) ', ...WINDOW },
				{
					queryRange: (_org, request) => {
						seen.push(request)
						return Effect.succeed(result(series))
					},
				},
			)
			assert.deepStrictEqual(
				{ ...seen[0] },
				{
					query: 'sum by (service) (rate({"run.googleapis.com/request_count"}[5m]))',
					startTime: "2026-10-15 10:00:00",
					endTime: "2026-10-15 12:00:00",
					stepSeconds: 60,
				},
			)
			const kept = answer.structured.series as ReadonlyArray<{ labels: Record<string, string> }>
			assert.strictEqual(kept.length, 100)
			assert.strictEqual(kept[0]?.labels.service, "svc-149")
			assert.strictEqual(answer.structured.totalSeries, 150)
			assert.include(
				answer.text,
				'| {project_id="shop-prod", service="svc-149"} | 149 | 1 | 75 | 149 | 2 |',
			)
			assert.notInclude(answer.text, "svc-129")
			assert.include(answer.text, "Showing 20 of 150 series")
			assert.include(answer.text, "Google bills per series returned")
			assert.include(answer.text, '`find_gcp_metrics metric="run.googleapis.com/request_count"`')
		}),
	)

	it.effect("evaluates an instant query at end_time and lists what could not be read", () =>
		Effect.gen(function* () {
			const seen: Array<GcpPromQlInstantRequest> = []
			const answer = yield* call(
				"query_gcp_promql",
				{ query: "up", kind: "instant", projects: "shop-prod", ...WINDOW },
				{
					queryInstant: (_org, request) => {
						seen.push(request)
						return Effect.succeed(
							Schema.decodeUnknownSync(GcpPromQlResult)({
								resultType: "vector",
								series: [
									{ labels: { project_id: "shop-prod" }, points: [[1_760_529_600, 0.5]] },
								],
								projects: ["shop-prod"],
								failures: [
									{ scope: "projects/shop-dev", message: "Run the setup script again." },
								],
							}),
						)
					},
				},
			)
			assert.deepStrictEqual(
				{ ...seen[0] },
				{ query: "up", time: "2026-10-15 12:00:00", projects: [project] },
			)
			assert.include(answer.text, '| {project_id="shop-prod"} | 0.5 |')
			assert.include(answer.text, "- projects/shop-dev: Run the setup script again.")
			assert.notProperty(answer.structured, "stepSeconds")
		}),
	)

	it.effect("hands Google's refusal of the query back as invalid input", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				call(
					"query_gcp_promql",
					{ query: "rate(x)", ...WINDOW },
					{
						queryRange: () =>
							Effect.fail(
								new GcpPromQlInvalidQueryError({
									message: "expected range vector",
									projectId: project,
								}),
							),
					},
				),
			)
			assert.strictEqual(error._tag, "@maple/mcp/errors/McpInvalidInputError")
			assert.include(error.message, "expected range vector")
		}),
	)

	it.effect("points the agent at the parameter to change", () =>
		Effect.gen(function* () {
			const failWith = (error: GcpPromQlTooManySeriesError | GcpPromQlTooManyProjectsError) =>
				Effect.flip(
					call(
						"query_gcp_promql",
						{ query: "up", ...WINDOW },
						{ queryRange: () => Effect.fail(error) },
					),
				)
			const series = yield* failWith(
				new GcpPromQlTooManySeriesError({ message: "Aggregate them.", series: 900 }),
			)
			assert.deepInclude(series, { _tag: "@maple/mcp/errors/McpInvalidInputError", parameter: "query" })
			const projects = yield* failWith(
				new GcpPromQlTooManyProjectsError({
					message: "Choose the projects to query.",
					projects: Array.from({ length: 25 }, (_, index) =>
						Schema.decodeUnknownSync(GcpProjectId)(`shop-${String(index).padStart(2, "0")}`),
					),
				}),
			)
			assert.deepInclude(projects, {
				_tag: "@maple/mcp/errors/McpInvalidInputError",
				parameter: "projects",
			})
			assert.include(projects.message, "shop-19 and 5 more.")
		}),
	)

	it.effect("refuses a step too fine for the window in the tool's own words", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				call(
					"query_gcp_promql",
					{
						query: "up",
						start_time: "2026-09-10 12:00:00",
						end_time: "2026-10-15 12:00:00",
						bucket_seconds: 60,
					},
					{},
				),
			)
			assert.strictEqual(error._tag, "@maple/mcp/errors/McpInvalidInputError")
			assert.include(error.message, "bucket_seconds")
			assert.notInclude(error.message, "stepSeconds")
		}),
	)

	it.effect("maps a deployment without a Google identity and an unreadable setup to their kinds", () =>
		Effect.gen(function* () {
			const unavailable = yield* Effect.flip(
				call(
					"query_gcp_promql",
					{ query: "up", ...WINDOW },
					{ queryRange: () => Effect.fail(new GcpPromQlUnavailableError({ message: "no key" })) },
				),
			)
			assert.deepInclude(unavailable, {
				_tag: "@maple/mcp/errors/McpUnavailableError",
				capability: "gcp_live_query",
			})
			const failed = yield* Effect.flip(
				call(
					"query_gcp_promql",
					{ query: "up", ...WINDOW },
					{
						queryRange: () =>
							Effect.fail(
								new GcpPromQlFailedError({
									message: "Run the setup script again.",
									failures: [],
								}),
							),
					},
				),
			)
			assert.strictEqual(failed._tag, "@maple/mcp/errors/McpNotReadyError")
			assert.include(failed.message, "setup script")
		}),
	)
})

describe("find_gcp_metrics", () => {
	it.effect("searches, says when more matched, and describes a metric with a starter query", () =>
		Effect.gen(function* () {
			const limits: Array<number | undefined> = []
			const answer = yield* call(
				"find_gcp_metrics",
				{
					search: "run.googleapis.com/request",
					metric: "run.googleapis.com/request_latencies",
					limit: 3,
				},
				{
					searchMetrics: (_org, request) => {
						limits.push(request.limit)
						return Effect.succeed(
							new GcpMetricSearchResponse({
								projectId: project,
								metrics: [
									"run.googleapis.com/request_count",
									"run.googleapis.com/request_latencies_bucket",
									"run.googleapis.com/request_latencies_count",
									"run.googleapis.com/request_latencies_sum",
								],
							}),
						)
					},
					describeMetric: () =>
						Effect.succeed(
							new GcpMetricDescriptor({
								type: "run.googleapis.com/request_latencies",
								metricKind: "DELTA",
								valueType: "DISTRIBUTION",
								unit: "ms",
								description: "Request latency",
								monitoredResourceTypes: ["cloud_run_revision"],
								labels: [{ key: "response_code", description: "HTTP status" }],
							}),
						),
				},
			)
			assert.deepStrictEqual(limits, [4])
			const search = answer.structured.search as { metrics: ReadonlyArray<string>; truncated: boolean }
			assert.strictEqual(search.metrics.length, 3)
			assert.isTrue(search.truncated)
			assert.include(answer.text, "| response_code | HTTP status |")
			assert.include(
				answer.text,
				'`query_gcp_promql query="histogram_quantile(0.95, sum by (le) (rate({\\"run.googleapis.com/request_latencies_bucket\\"}[5m])))"`',
			)
			// A distribution's names describe as one metric; a plain `_count` counter stays itself.
			assert.include(
				answer.text,
				'`find_gcp_metrics metric="run.googleapis.com/request_count" project="shop-prod"`',
			)
			assert.include(
				answer.text,
				'`find_gcp_metrics metric="run.googleapis.com/request_latencies" project="shop-prod"`',
			)
			assert.notInclude(answer.text, 'metric="run.googleapis.com/request_latencies_count"')
		}),
	)

	it.effect("asks for a search or a metric", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(call("find_gcp_metrics", {}, {}))
			assert.strictEqual(error._tag, "@maple/mcp/errors/McpInvalidInputError")
		}),
	)
})
