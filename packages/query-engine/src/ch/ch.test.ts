import { describe, expect, it } from "vitest"
import { compileUnsafe, compileUnionUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { tracesTimeseriesQuery, tracesBreakdownQuery, tracesListQuery } from "./queries/traces"
import { sessionReplaysFacetsQuery } from "./queries/session-replays"
import { metricsSummaryQuery } from "./queries/metrics"
import {
	tracesDurationStatsQuery,
	spanHierarchyQuery,
	spanEventsByTraceQuery,
	traceTimeProbeQuery,
	recentTraceTimeProbeQuery,
} from "./queries/errors"
import { OrgId } from "@maple/domain"

// Traces timeseries query — parity with buildTracesTimeseriesSQL

describe("tracesTimeseriesQuery", () => {
	const baseParams = {
		orgId: OrgId.make("org_123"),
		startTime: "2024-01-01 00:00:00",
		endTime: "2024-01-02 00:00:00",
		bucketSeconds: 3600,
	}

	it("builds basic count timeseries", () => {
		const q = tracesTimeseriesQuery({ metric: "count", needsSampling: false })
		const { sql } = compileUnsafe(q, baseParams)
		// Without rootOnly the query means "all spans", which the entry-point-only
		// MV cannot answer — it reads raw traces.
		expect(sql).toContain("FROM traces")
		expect(sql).toContain("sum(traces.SampleRate) AS count")
		expect(sql).toContain("INTERVAL 3600 SECOND")
		expect(sql).toContain("GROUP BY bucket, groupName")
		expect(sql).toContain("ORDER BY bucket ASC, groupName ASC")
		// oxlint-disable-next-line test-slop/no-sql-text-pin -- a count metric reports no quantiles
		expect(sql).toContain("0 AS p50Duration")
	})

	it("builds apdex timeseries with threshold", () => {
		const q = tracesTimeseriesQuery({ metric: "apdex", needsSampling: false, apdexThresholdMs: 250 })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain(
			"countIf((NOT (traces.StatusCode = 'Error') AND traces.Duration / 1000000 < 250)) AS satisfiedCount",
		)
	})

	it("counts errored spans as frustrated in apdex (excludes them from satisfied/tolerating)", () => {
		const q = tracesTimeseriesQuery({ metric: "apdex", needsSampling: false, apdexThresholdMs: 250 })
		const { sql } = compileUnsafe(q, baseParams)
		// A fast error must NOT inflate apdex: the non-error predicate gates both
		// the satisfied and tolerating buckets, while count() still includes errors.
		expect(sql).toContain(
			"countIf((NOT (traces.StatusCode = 'Error') AND traces.Duration / 1000000 < 250)) AS satisfiedCount",
		)
		expect(sql).toContain(
			"countIf((NOT (traces.StatusCode = 'Error') AND (traces.Duration / 1000000 >= 250 AND traces.Duration / 1000000 < 1000))) AS toleratingCount",
		)
		// satisfied and tolerating are divided by the unfiltered count(), so errors drag the score down.
		expect(sql).toContain("/ count()")
	})

	it("builds p95 duration timeseries", () => {
		const q = tracesTimeseriesQuery({ metric: "p95_duration", needsSampling: false })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("quantile(0.5)(traces.Duration) / 1000000 AS p50Duration")
		expect(sql).toContain("quantile(0.95)(traces.Duration) / 1000000 AS p95Duration")
		expect(sql).toContain("quantile(0.99)(traces.Duration) / 1000000 AS p99Duration")
	})

	it("builds error_rate timeseries weighted on both sides of the ratio", () => {
		const q = tracesTimeseriesQuery({ metric: "error_rate", needsSampling: false })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain(
			"sumIf(traces.SampleRate, traces.StatusCode = 'Error') / sum(traces.SampleRate), 0) AS errorRate",
		)
	})

	it("emits sum(SampleRate) when needsSampling is true", () => {
		const q = tracesTimeseriesQuery({ metric: "count", needsSampling: true })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("sum(traces.SampleRate) AS estimatedSpanCount")
		// The old non-deterministic `anyIf(threshold)` is gone — it was the bug.
		expect(sql).not.toContain("dominantThreshold")
		expect(sql).not.toContain("anyIf")
	})

	it("emits a constant 0 estimatedSpanCount when needsSampling is false", () => {
		const q = tracesTimeseriesQuery({ metric: "count", needsSampling: false })
		const { sql } = compileUnsafe(q, baseParams)
		// oxlint-disable-next-line test-slop/no-sql-text-pin -- an unsampled query reports no estimate
		expect(sql).toContain("0 AS estimatedSpanCount")
	})

	it("groups by multiple dimensions", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			groupBy: ["service", "status_code"],
		})
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("arrayStringConcat")
		expect(sql).toContain("arrayFilter")
	})

	it("groups by attribute with keys", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			groupBy: ["attribute"],
			groupByAttributeKeys: ["http.route"],
		})
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("SpanAttributes['http.route']")
	})

	it("routes rootOnly to service_overview_spans_mv (MV pre-filters entry-point spans)", () => {
		const q = tracesTimeseriesQuery({ metric: "count", needsSampling: false, rootOnly: true })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("FROM service_overview_spans")
		// Filter is redundant on the MV and is dropped.
		expect(sql).not.toContain("SpanKind")
		expect(sql).not.toContain("ParentSpanId")
	})

	it("routes annual all-metric service charts through raw partial hours and hourly interiors", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: true,
			allMetrics: true,
			rootOnly: true,
			bucketSeconds: 3600,
			serviceName: "api",
			environments: ["production"],
		})
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("FROM service_overview_spans")
		expect(sql).toContain("FROM service_overview_hourly")
		expect(sql).toContain("Timestamp < if(toDateTime('2024-01-01 00:00:00')")
		expect(sql).toContain("Hour < toStartOfHour(toDateTime('2024-01-02 00:00:00'))")
		// Weighted estimate, with a raw-count fallback for buckets written before
		// `EstimatedSpanCount` existed. `count` reports the same expression. Both
		// `if()` arms must unify to Float64 — ClickHouse rejects a Float64/UInt64
		// pair outright, so dropping the `toFloat64` breaks the query at runtime.
		expect(sql).toContain(
			"if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS count",
		)
		expect(sql).toContain(
			"if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedSpanCount), toFloat64(sum(bCount))) AS estimatedSpanCount",
		)
		expect(sql).toContain("quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles)")
	})

	// `service_overview_spans` stores only entry-point spans (Server/Consumer OR
	// root). Routing an all-spans query there silently swaps the population, which
	// is how one dashboard showed two answers to the same question.
	it("keeps non-rootOnly queries off service_overview_spans_mv", () => {
		const q = tracesTimeseriesQuery({ metric: "count", needsSampling: false, bucketSeconds: 300 })
		const { sql } = compileUnsafe(q, { ...baseParams, bucketSeconds: 300 })
		expect(sql).not.toContain("FROM service_overview_spans")
		expect(sql).toContain("FROM traces")
	})

	it("routes eligible hourly trace timeseries to traces_aggregates_hourly", () => {
		const q = tracesTimeseriesQuery({
			metric: "p95_duration",
			needsSampling: false,
			rootOnly: true,
			groupBy: ["service"],
			bucketSeconds: 3600,
		})
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("FROM traces_aggregates_hourly")
		// Whole-hour interior state is re-emitted for the union, then merged once
		// in the outer query alongside the raw partial-hour edges.
		expect(sql).toContain("quantilesTDigestWeightedMergeState(0.5, 0.95, 0.99)(DurationQuantiles)")
		expect(sql).toContain(
			"quantilesTDigestWeightedState(0.5, 0.95, 0.99)(Duration, toUInt32(greatest(SampleRate, 1.0)))",
		)
		expect(sql).toContain("quantilesTDigestWeightedMerge(0.5, 0.95, 0.99)(bDurationQuantiles)")
		expect(sql).toContain("IsEntryPoint = 1")
		expect(sql).not.toContain("FROM service_overview_spans")
	})

	// This is the shape `computeAlertBuckets` produces: one metric, sub-hour
	// bucket, root spans only, and no `allMetrics`. It used to fall all the way
	// through to a flat scan of the per-span `service_overview_spans` because
	// `canUseAnnualServiceOverview` demanded `allMetrics === true` — 165k scans
	// per 3 days against a 325M-row table while the 2.2M-row minutely rollup
	// built for it sat unreachable.
	//
	// Asserting the minutely tier specifically, NOT just the presence of a table
	// name: the tiered union reads `service_overview_spans` too (as its partial-
	// bucket edge), so `toContain("FROM service_overview_spans")` passes on both
	// routes and cannot tell them apart. That weak assertion is what let the
	// regression sit here unnoticed.
	it("routes fine-grained single-metric trace timeseries to the minutely rollup", () => {
		const q = tracesTimeseriesQuery({
			metric: "p95_duration",
			needsSampling: false,
			rootOnly: true,
			bucketSeconds: 300,
		})
		const { sql } = compileUnsafe(q, { ...baseParams, bucketSeconds: 300 })
		expect(sql).toContain("FROM service_overview_minutely")
		// The raw edge covers only the partial minutes at the window's ends.
		expect(sql).toContain("FROM service_overview_spans")
		// Sub-hour buckets have no position inside an hour-floored row.
		expect(sql).not.toContain("FROM service_overview_hourly")
		expect(sql).not.toContain("FROM traces_aggregates_hourly")
	})

	// The other side of that route: a groupBy the rollup tiers cannot serve
	// (`status_code` is pre-aggregated into `ErrorCount`) must still fall through
	// to the flat per-span scan.
	it("keeps status_code breakdowns on the flat service_overview_spans scan", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			rootOnly: true,
			groupBy: ["status_code"],
			bucketSeconds: 300,
		})
		const { sql } = compileUnsafe(q, { ...baseParams, bucketSeconds: 300 })
		expect(sql).toContain("FROM service_overview_spans")
		expect(sql).not.toContain("FROM service_overview_minutely")
	})

	it("keeps all-metrics and Apdex timeseries off traces_aggregates_hourly", () => {
		const allMetrics = compileUnsafe(
			tracesTimeseriesQuery({
				metric: "count",
				needsSampling: true,
				allMetrics: true,
				rootOnly: true,
				bucketSeconds: 3600,
			}),
			baseParams,
		).sql
		const apdex = compileUnsafe(
			tracesTimeseriesQuery({
				metric: "apdex",
				needsSampling: false,
				rootOnly: true,
				bucketSeconds: 3600,
			}),
			baseParams,
		).sql

		expect(allMetrics).toContain("FROM service_overview_spans")
		expect(allMetrics).not.toContain("FROM traces_aggregates_hourly")
		expect(apdex).toContain("FROM service_overview_spans")
		expect(apdex).not.toContain("FROM traces_aggregates_hourly")
	})

	it("uses pre-extracted CommitSha column when routing to MV", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			rootOnly: true,
			commitShas: ["abc123"],
		})
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("FROM service_overview_spans")
		expect(sql).toContain("CommitSha IN ('abc123')")
	})

	it("filters by serviceName", () => {
		const q = tracesTimeseriesQuery({ metric: "count", needsSampling: false, serviceName: "api-service" })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("ServiceName = 'api-service'")
	})

	it("filters by spanName", () => {
		const q = tracesTimeseriesQuery({ metric: "count", needsSampling: false, spanName: "GET /users" })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("SpanName = 'GET /users'")
	})

	it("filters errorsOnly", () => {
		const q = tracesTimeseriesQuery({ metric: "count", needsSampling: false, errorsOnly: true })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("StatusCode = 'Error'")
	})

	it("filters errorsOnly with rootOnly", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			rootOnly: true,
			errorsOnly: true,
		})
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("StatusCode = 'Error'")
	})

	it("filters by environments (raw path reads the ResourceAttributes map)", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			environments: ["production", "staging"],
		})
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("FROM traces")
		expect(sql).toContain(
			"coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) IN ('production', 'staging')",
		)
	})

	it("filters by environments with rootOnly (MV path uses pre-extracted DeploymentEnv)", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			rootOnly: true,
			environments: ["production"],
		})
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("FROM service_overview_spans")
		expect(sql).toContain("DeploymentEnv IN ('production')")
	})

	it("filters by attribute filters (equals)", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			attributeFilters: [{ key: "http.status_code", value: "200", mode: "equals" }],
		})
		const { sql } = compileUnsafe(q, baseParams)
		// Coalesces the old + new OTel semconv spellings (mirrors trace_list_mv).
		expect(sql).toContain(
			"if(SpanAttributes['http.status_code'] != '', SpanAttributes['http.status_code'], SpanAttributes['http.response.status_code']) = '200'",
		)
	})

	it("filters by attribute filters (exists)", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			attributeFilters: [{ key: "http.route", mode: "exists" }],
		})
		const { sql } = compileUnsafe(q, baseParams)
		// A missing Map key reads back as '', so `exists` must also exclude empty
		// values — otherwise breakdowns keep a "(no value)" bucket.
		expect(sql).toContain(
			"mapContains(SpanAttributes, 'http.route') AND SpanAttributes['http.route'] != ''",
		)
	})

	it("filters by attribute filters (exists) across HTTP semconv aliases", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			attributeFilters: [{ key: "http.status_code", mode: "exists" }],
		})
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain(
			"(mapContains(SpanAttributes, 'http.status_code') OR mapContains(SpanAttributes, 'http.response.status_code')) AND if(SpanAttributes['http.status_code'] != '', SpanAttributes['http.status_code'], SpanAttributes['http.response.status_code']) != ''",
		)
	})

	it("filters by attribute filters (!exists) as the complement of exists", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			attributeFilters: [{ key: "http.route", mode: "exists", negated: true }],
		})
		const { sql } = compileUnsafe(q, baseParams)
		// Absent *or* empty — the exact negation of the positive predicate.
		expect(sql).toContain(
			"NOT ((mapContains(SpanAttributes, 'http.route') AND SpanAttributes['http.route'] != ''))",
		)
	})

	it("filters by attribute filters (contains)", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			attributeFilters: [{ key: "http.route", value: "/api", mode: "contains" }],
		})
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("positionCaseInsensitive(SpanAttributes['http.route'], '/api') > 0")
	})

	it("filters by attribute filters (gt)", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			attributeFilters: [{ key: "http.status_code", value: "400", mode: "gt" }],
		})
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain(
			"toFloat64OrZero(if(SpanAttributes['http.status_code'] != '', SpanAttributes['http.status_code'], SpanAttributes['http.response.status_code'])) > 400",
		)
	})

	it("filters by resource attribute filters", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			resourceAttributeFilters: [{ key: "host.name", value: "server-1", mode: "equals" }],
		})
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("ResourceAttributes['host.name'] = 'server-1'")
	})

	// Either spelling of the renamed deployment-environment resource attribute
	// has to match either stored key: our SDKs dual-emit, a current OTel SDK
	// sends only `deployment.environment.name`, an older one only the legacy key.
	for (const key of ["deployment.environment", "deployment.environment.name"]) {
		it(`matches both deployment-environment spellings when filtering on ${key}`, () => {
			const q = tracesTimeseriesQuery({
				metric: "count",
				needsSampling: false,
				resourceAttributeFilters: [{ key, value: "production", mode: "equals" }],
			})
			const { sql } = compileUnsafe(q, baseParams)
			expect(sql).toContain(
				"if(ResourceAttributes['deployment.environment.name'] != '', ResourceAttributes['deployment.environment.name'], ResourceAttributes['deployment.environment']) = 'production'",
			)
		})
	}

	it("filters attribute with rootOnly on raw table", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			rootOnly: true,
			attributeFilters: [{ key: "http.method", value: "GET", mode: "equals" }],
		})
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("FROM traces")
		expect(sql).toContain(
			"if(SpanAttributes['http.method'] != '', SpanAttributes['http.method'], SpanAttributes['http.request.method']) = 'GET'",
		)
	})

	it("falls back to raw traces when groupBy includes span_name", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			groupBy: ["span_name"],
		})
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("FROM traces")
	})

	it("falls back to raw traces when spanName filter is set", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			spanName: "GET /users",
		})
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("FROM traces")
	})

	it("falls back to raw traces when resourceAttributeFilters are set", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			resourceAttributeFilters: [{ key: "host.name", value: "server-1", mode: "equals" }],
		})
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("FROM traces")
		expect(sql).toContain("ResourceAttributes['host.name'] = 'server-1'")
	})

	it("escapes special characters in filter values", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			serviceName: "it's-a-service",
		})
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("ServiceName = 'it\\'s-a-service'")
	})
})

// Traces breakdown query — parity with buildTracesBreakdownSQL

describe("tracesBreakdownQuery", () => {
	const baseParams = {
		orgId: OrgId.make("org_123"),
		startTime: "2024-01-01 00:00:00",
		endTime: "2024-01-02 00:00:00",
	}

	it("builds basic breakdown by service", () => {
		const q = tracesBreakdownQuery({ metric: "count", groupBy: "service" })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).not.toContain("FROM service_overview_spans")
		expect(sql).toContain("sum(traces.SampleRate) AS count")
		expect(sql).toContain("GROUP BY name")
		expect(sql).toContain("ORDER BY count DESC")
		expect(sql).toContain("LIMIT 10")
	})

	it("keeps span_name breakdowns on raw traces", () => {
		const q = tracesBreakdownQuery({ metric: "count", groupBy: "span_name" })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("FROM traces")
		expect(sql).not.toContain("FROM service_overview_spans")
		// oxlint-disable-next-line test-slop/no-sql-text-pin -- the breakdown's group key
		expect(sql).toContain("SpanName AS name")
	})

	it("keeps status_code breakdowns on raw traces", () => {
		const q = tracesBreakdownQuery({ metric: "count", groupBy: "status_code" })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("FROM traces")
		// oxlint-disable-next-line test-slop/no-sql-text-pin -- the breakdown's group key
		expect(sql).toContain("StatusCode AS name")
	})

	it("routes rootOnly breakdowns to service_overview_spans_mv", () => {
		const q = tracesBreakdownQuery({ metric: "count", groupBy: "service", rootOnly: true })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("FROM service_overview_spans")
		expect(sql).toContain("sum(service_overview_spans.SampleRate) AS count")
	})

	it("groups by http_method", () => {
		const q = tracesBreakdownQuery({ metric: "count", groupBy: "http_method" })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("FROM traces")
		expect(sql).not.toContain("FROM service_overview_spans")
		expect(sql).toContain(
			"if(traces.SpanAttributes['http.method'] != '', traces.SpanAttributes['http.method'], traces.SpanAttributes['http.request.method']) AS name",
		)
	})

	it("groups by environment under either semconv spelling on the raw path", () => {
		const q = tracesBreakdownQuery({ metric: "count", groupBy: "environment" })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("FROM traces")
		expect(sql).toContain(
			"coalesce(nullIf(traces.ResourceAttributes['deployment.environment.name'], ''), traces.ResourceAttributes['deployment.environment']) AS name",
		)
	})

	it("groups a timeseries by http_method under either semconv spelling", () => {
		const q = tracesTimeseriesQuery({
			metric: "count",
			needsSampling: false,
			groupBy: ["http_method"],
			bucketSeconds: 300,
		})
		const { sql } = compileUnsafe(q, { ...baseParams, bucketSeconds: 300 })
		expect(sql).toContain(
			"if(traces.SpanAttributes['http.method'] != '', traces.SpanAttributes['http.method'], traces.SpanAttributes['http.request.method'])",
		)
	})

	it("ORs a filter with its alternatives, each under its own semconv aliases", () => {
		const q = tracesListQuery({
			attributeFilters: [
				{
					key: "messaging.system",
					value: "kafka",
					mode: "equals",
					or: [{ key: "messaging.destination.name", mode: "exists", negated: true }],
				},
			],
		})
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("(SpanAttributes['messaging.system'] = 'kafka' OR NOT (")
		expect(sql).toContain("mapContains(SpanAttributes, 'messaging.destination.name')")
		expect(sql).toContain("mapContains(SpanAttributes, 'messaging.destination')")
	})

	it("matches every http target the service map names when filtering on server.address", () => {
		const q = tracesListQuery({
			attributeFilters: [{ key: "server.address", value: "x", mode: "equals" }],
		})
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain(
			"if(SpanAttributes['server.address'] != '', SpanAttributes['server.address'], if(SpanAttributes['http.host'] != '', SpanAttributes['http.host'], SpanAttributes['url.authority'])) = 'x'",
		)
	})

	// Dependency drilldowns and dashboard templates filter on these keys. The
	// spelling the user typed is read first, so a saved legacy filter keeps its
	// meaning on spans that dual-emit a different value under the new key.
	for (const [key, first, second] of [
		["db.system", "db.system", "db.system.name"],
		["db.system.name", "db.system.name", "db.system"],
		["messaging.destination.name", "messaging.destination.name", "messaging.destination"],
		["rpc.system", "rpc.system", "rpc.system.name"],
		["rpc.system.name", "rpc.system.name", "rpc.system"],
	] as const) {
		it(`matches both semconv spellings when filtering on ${key}`, () => {
			const q = tracesListQuery({ attributeFilters: [{ key, value: "x", mode: "equals" }] })
			const { sql } = compileUnsafe(q, baseParams)
			expect(sql).toContain(
				`if(SpanAttributes['${first}'] != '', SpanAttributes['${first}'], SpanAttributes['${second}']) = 'x'`,
			)
		})
	}

	it("keeps custom attribute breakdowns on raw traces", () => {
		const q = tracesBreakdownQuery({
			metric: "count",
			groupBy: "attribute",
			groupByAttributeKey: "rpc.service",
		})
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("FROM traces")
		expect(sql).not.toContain("FROM service_overview_spans")
		// oxlint-disable-next-line test-slop/no-sql-text-pin -- the breakdown's group key
		expect(sql).toContain("SpanAttributes['rpc.service'] AS name")
	})

	it("applies custom limit", () => {
		const q = tracesBreakdownQuery({ metric: "count", groupBy: "service", limit: 25 })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("LIMIT 25")
	})

	it("includes apdex columns for apdex metric", () => {
		const q = tracesBreakdownQuery({ metric: "apdex", groupBy: "service", apdexThresholdMs: 300 })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain(
			"countIf((NOT (traces.StatusCode = 'Error') AND traces.Duration / 1000000 < 300)) AS satisfiedCount",
		)
	})

	it("includes quantile columns for p99 metric", () => {
		const q = tracesBreakdownQuery({ metric: "p99_duration", groupBy: "service" })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("quantile(0.99)(traces.Duration) / 1000000 AS p99Duration")
	})

	it("applies WHERE filters", () => {
		const q = tracesBreakdownQuery({
			metric: "count",
			groupBy: "service",
			serviceName: "api",
			errorsOnly: true,
		})
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("FROM traces")
		expect(sql).toContain("ServiceName = 'api'")
		expect(sql).toContain("StatusCode = 'Error'")
	})

	it("uses pre-extracted deployment env on the service overview branch", () => {
		const q = tracesBreakdownQuery({
			metric: "count",
			groupBy: "service",
			rootOnly: true,
			environments: ["prod"],
		})
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("FROM service_overview_spans")
		expect(sql).toContain("DeploymentEnv IN ('prod')")
		expect(sql).not.toContain("ResourceAttributes")
	})

	it("falls back to raw traces for resource attribute filters", () => {
		const q = tracesBreakdownQuery({
			metric: "count",
			groupBy: "service",
			resourceAttributeFilters: [{ key: "host.name", value: "server-1", mode: "equals" }],
		})
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("FROM traces")
		expect(sql).not.toContain("FROM service_overview_spans")
		expect(sql).toContain("ResourceAttributes['host.name'] = 'server-1'")
	})
})

// Traces list query

describe("tracesListQuery", () => {
	const baseParams = {
		orgId: OrgId.make("org_123"),
		startTime: "2024-01-01 00:00:00",
		endTime: "2024-01-02 00:00:00",
	}

	it("builds basic list query", () => {
		const q = tracesListQuery({})
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("ORDER BY timestamp DESC")
		expect(sql).toContain("LIMIT 25")
	})

	it("applies custom limit", () => {
		const q = tracesListQuery({ limit: 50 })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("LIMIT 50")
	})

	it("filters by service", () => {
		const q = tracesListQuery({ serviceName: "api" })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("ServiceName = 'api'")
	})

	it("emits IN for multiple services", () => {
		const q = tracesListQuery({ serviceNames: ["api", "checkout", "billing"] })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("ServiceName IN ('api', 'checkout', 'billing')")
		// Regression: the sidebar is multi-select, but the query layer used to take
		// only `services[0]`, so ticking three services filtered by one.
		expect(sql).not.toContain("ServiceName = 'api'")
	})

	it("keeps plain equality for a single service in the array spelling", () => {
		const q = tracesListQuery({ serviceNames: ["api"] })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("ServiceName = 'api'")
	})

	it("lets serviceNames win over the scalar serviceName", () => {
		const q = tracesListQuery({ serviceName: "api", serviceNames: ["checkout", "billing"] })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("ServiceName IN ('checkout', 'billing')")
		expect(sql).not.toContain("ServiceName = 'api'")
	})

	it("emits IN against both raw and display span names for multiple spanNames", () => {
		const q = tracesListQuery({ spanNames: ["GET /a", "GET /b"] })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("SpanName IN ('GET /a', 'GET /b')")
		// Display-name aware, same as the single-value path.
		expect(sql).toContain("replaceOne(traces.SpanName, 'http.server ', '')")
	})

	it("emits IN for a multi-value http attribute filter", () => {
		const q = tracesListQuery({
			attributeFilters: [{ key: "http.method", values: ["GET", "POST"], mode: "in" }],
		})
		const { sql } = compileUnsafe(q, baseParams)
		// Coalesced across the http.method / http.request.method semconv aliases.
		expect(sql).toMatch(/IN \('GET', 'POST'\)/)
	})

	it("uses traces table when rootOnly (MV disabled)", () => {
		const q = tracesListQuery({ rootOnly: true })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("FROM traces")
	})

	it("emits NOT IN for excludedServiceNames", () => {
		const q = tracesListQuery({ excludedServiceNames: ["checkout", "billing"] })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("ServiceName NOT IN ('checkout', 'billing')")
	})

	it("emits NOT IN for excludedSpanNames", () => {
		const q = tracesListQuery({ excludedSpanNames: ["GET /health"] })
		const { sql } = compileUnsafe(q, baseParams)
		// Display-name aware: excludes rows whose raw OR rewritten span name
		// matches, so excluding a "Root Span" facet value ("GET /route") works.
		expect(sql).toMatch(/NOT \(\(traces\.SpanName IN \('GET \/health'\) OR /)
		expect(sql).toContain("replaceOne(traces.SpanName, 'http.server ', '')")
	})

	it("wraps a negated attribute filter in NOT (...)", () => {
		const q = tracesListQuery({
			attributeFilters: [{ key: "env", value: "prod", mode: "equals", negated: true }],
		})
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("NOT (SpanAttributes['env'] = 'prod')")
	})

	it("wraps a negated contains attribute filter in NOT (positionCaseInsensitive ...)", () => {
		const q = tracesListQuery({
			attributeFilters: [{ key: "http.route", value: "/health", mode: "contains", negated: true }],
		})
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("NOT (positionCaseInsensitive(SpanAttributes['http.route'], '/health') > 0)")
	})
})

// Converted queries — smoke tests

describe("converted queries", () => {
	const baseParams = { orgId: OrgId.make("org_1"), startTime: "2024-01-01", endTime: "2024-01-02" }

	it("sessionReplaysFacetsQuery counts sessions, not replay events", () => {
		const q = sessionReplaysFacetsQuery({})
		const { sql } = compileUnionUnsafe(q, baseParams)
		expect(sql).toContain("uniq(session_replays.SessionId) AS count")
		expect(sql).toContain("ORDER BY count DESC")
	})

	it("sessionReplaysFacetsQuery excludes each facet's own filter", () => {
		const q = sessionReplaysFacetsQuery({ browser: "Chrome", deviceType: "mobile" })
		const { sql } = compileUnionUnsafe(q, baseParams)
		// The browser branch must still see every browser (no BrowserName = 'Chrome'
		// constraint), but other branches keep it so their counts respect the filter.
		const branches = sql.split("UNION ALL")
		const browserBranch = branches.find((b) => b.includes("'browser' AS facetType"))!
		const serviceBranch = branches.find((b) => b.includes("'service' AS facetType"))!
		expect(browserBranch).not.toContain("BrowserName = 'Chrome'")
		expect(serviceBranch).toContain("BrowserName = 'Chrome'")
		expect(serviceBranch).toContain("DeviceType = 'mobile'")
	})

	it("metricsSummaryQuery aggregates the metric_catalog rollup", () => {
		const q = metricsSummaryQuery()
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).not.toContain("UNION ALL")
		expect(sql).toContain("FROM metric_catalog")
		expect(sql).toContain("GROUP BY metricType")
		expect(sql).toContain("uniq(metric_catalog.MetricName)")
	})

	it("tracesDurationStatsQuery compiles with positionCaseInsensitive", () => {
		const q = tracesDurationStatsQuery({
			serviceName: "api",
			matchModes: { serviceName: "contains" },
		})
		const { sql } = compileUnsafe(q, baseParams)
		// On both tiers: the trace_list_mv edges and the hourly interior.
		expect(sql.match(/positionCaseInsensitive\((\w+\.)?ServiceName, 'api'\) > 0/g)).toHaveLength(2)
	})

	it("spanHierarchyQuery never projects the full attribute maps and caps the row count", () => {
		const q = spanHierarchyQuery({ traceId: "abc123" })
		const { sql } = compileUnsafe(q, { orgId: OrgId.make("org_1") })
		// Maps are trimmed to the keys the tree views render — never the full map.
		expect(sql).not.toContain("toJSONString(SpanAttributes)")
		expect(sql).not.toContain("toJSONString(ResourceAttributes)")
		// Capped so pathological traces can't stall the API.
		expect(sql).toContain("ORDER BY startTime ASC")
		expect(sql).toContain("LIMIT 5000")
	})

	it("spanHierarchyQuery without narrowByTime omits Timestamp filter", () => {
		const q = spanHierarchyQuery({ traceId: "abc" })
		const { sql } = compileUnsafe(q, { orgId: OrgId.make("org_1") })
		expect(sql).not.toContain("Timestamp >=")
		expect(sql).not.toContain("Timestamp <=")
	})

	it("spanEventsByTraceQuery reads only spans with events inside the trace window", () => {
		const q = spanEventsByTraceQuery({ traceId: "abc", limit: 10 })
		const { sql } = compileUnsafe(q, {
			orgId: OrgId.make("org_1"),
			startTime: "2026-04-15 13:00:00",
			endTime: "2026-04-15 13:00:05",
		})
		expect(sql).toContain("notEmpty(traces.EventsName)")
		expect(sql).toMatch(/ORDER BY spanStart ASC\s+LIMIT 10/)
		expect(sql).not.toContain("EventsAttributes")
	})

	it("traceTimeProbeQuery aggregates the trace's first and last span over its trace_index rows", () => {
		const q = traceTimeProbeQuery({ traceId: "abc123" })
		const { sql } = compileUnsafe(q, { orgId: OrgId.make("org_1") })
		// The window must span every index row, not the earliest one.
		expect(sql).toContain("min(trace_index.MinTimestamp) AS timestamp")
		// A long trace's tail lives in later rows.
		expect(sql).toContain("max(trace_index.MaxTimestamp) AS endTimestamp")
		// Grouped, so an unknown trace returns no row rather than epoch-zero aggregates.
		expect(sql).toMatch(/GROUP BY traceId\s+LIMIT 1/)
		expect(sql).not.toContain("toJSONString")
		// Unbounded fallback shape: no time predicate.
		expect(sql).not.toContain("Timestamp >=")
	})

	it("recentTraceTimeProbeQuery bounds the trace's MaxTimestamp below for partition pruning", () => {
		const q = recentTraceTimeProbeQuery({ traceId: "abc123" })
		const { sql } = compileUnsafe(q, { orgId: OrgId.make("org_1"), startTime: "2026-04-15 13:00:00" })
		expect(sql).toContain("trace_index.MaxTimestamp >= '2026-04-15 13:00:00'")
		// Lower bound only — "recent" needs no upper bound.
		expect(sql).not.toContain("Timestamp <=")
	})
})
