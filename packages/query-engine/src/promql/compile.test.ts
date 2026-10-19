import { assert, describe, it } from "@effect/vitest"
import { DeploymentEnvironment, MetricName, ServiceName } from "@maple/domain"
import type { GcpMetricDescriptor } from "@maple/domain/gcp-live-metrics"
import type { AttributeFilter, MetricsFilters, MetricsMetric } from "@maple/domain/query-engine"
import { Effect } from "effect"
import { QueryEngineValidationError } from "@maple/domain/http"
import {
	compileGcpLabelValues,
	compileGcpMetricQuery,
	compileGcpSampleCount,
	gcpFilterProjects,
	gcpPointBucket,
	gcpRangeWindow,
	type GcpPromQl,
} from "./compile"

const descriptor = (overrides: Partial<GcpMetricDescriptor> & Pick<GcpMetricDescriptor, "type">) =>
	({
		metricKind: "GAUGE",
		valueType: "DOUBLE",
		unit: "1",
		description: "",
		monitoredResourceTypes: ["cloudsql_database"],
		labels: [],
		...overrides,
	}) satisfies GcpMetricDescriptor

const cpu = descriptor({ type: "cloudsql.googleapis.com/database/cpu/utilization" })
const transactions = descriptor({
	type: "cloudsql.googleapis.com/database/postgresql/transaction_count",
	metricKind: "DELTA",
	valueType: "INT64",
})
const coreUsage = descriptor({
	type: "kubernetes.io/container/cpu/core_usage_time",
	metricKind: "CUMULATIVE",
	monitoredResourceTypes: ["k8s_container"],
})
const latencies = descriptor({
	type: "serviceruntime.googleapis.com/api/request_latencies",
	metricKind: "DELTA",
	valueType: "DISTRIBUTION",
	monitoredResourceTypes: ["consumed_api"],
})

interface CompileOptions {
	readonly filters?: Partial<MetricsFilters>
	readonly groupLabel?: string
	readonly windowSeconds?: number
}

const request = (d: GcpMetricDescriptor, metric: MetricsMetric, options: CompileOptions = {}) => ({
	metric,
	filters: { metricName: MetricName.make(d.type), metricType: "gauge" as const, ...options.filters },
	groupLabel: options.groupLabel,
	windowSeconds: options.windowSeconds ?? 60,
})

const compile = (d: GcpMetricDescriptor, metric: MetricsMetric, options?: CompileOptions) =>
	compileGcpMetricQuery(request(d, metric, options), d)

const query = (d: GcpMetricDescriptor, metric: MetricsMetric, options?: CompileOptions) =>
	compile(d, metric, options).pipe(Effect.map((compiled) => compiled.query))

const rejection = (d: GcpMetricDescriptor, metric: MetricsMetric, options?: CompileOptions) =>
	compile(d, metric, options).pipe(
		Effect.flip,
		Effect.map((error) => {
			assert.instanceOf(error, QueryEngineValidationError)
			return error.message
		}),
	)

const withFilters = (attributeFilters: ReadonlyArray<AttributeFilter>) => ({ filters: { attributeFilters } })

const CPU = `{"cloudsql.googleapis.com/database/cpu/utilization", monitored_resource="cloudsql_database"}`
const TX = `{"cloudsql.googleapis.com/database/postgresql/transaction_count", monitored_resource="cloudsql_database"}`
const CORE = `{"kubernetes.io/container/cpu/core_usage_time", monitored_resource="k8s_container"}`
const LAT = (suffix: string) =>
	`{"serviceruntime.googleapis.com/api/request_latencies_${suffix}", monitored_resource="consumed_api"}`
const avgParts = (sum: string, count: string) =>
	`label_replace(${sum}, "maple_part", "sum", "", "") or label_replace(${count}, "maple_part", "count", "", "")`

const cases = (
	d: GcpMetricDescriptor,
	expected: ReadonlyArray<readonly [MetricsMetric, string, GcpPromQl["merge"]]>,
	windowSeconds?: number,
) => {
	for (const [metric, promQl, merge] of expected) {
		it.effect(metric, () =>
			Effect.gen(function* () {
				const compiled = yield* compile(d, metric, { windowSeconds })
				assert.deepStrictEqual(compiled, { query: promQl, merge })
			}),
		)
	}
}

describe("compileGcpMetricQuery", () => {
	describe("GAUGE", () =>
		cases(cpu, [
			[
				"avg",
				avgParts(
					`sum by (project_id) (sum_over_time(${CPU}[60s]))`,
					`sum by (project_id) (count_over_time(${CPU}[60s]))`,
				),
				"avg",
			],
			["min", `min by (project_id) (min_over_time(${CPU}[60s]))`, "min"],
			["max", `max by (project_id) (max_over_time(${CPU}[60s]))`, "max"],
			["sum", `sum by (project_id) (sum_over_time(${CPU}[60s]))`, "sum"],
			["count", `sum by (project_id) (count_over_time(${CPU}[60s]))`, "sum"],
			["rate", `sum by (project_id) (rate(${CPU}[120s]))`, "sum"],
			["increase", `sum by (project_id) (rate(${CPU}[120s])) * 60`, "sum"],
		]))

	describe("DELTA", () =>
		cases(
			transactions,
			[
				// Summing the deltas is exact; `increase` would extrapolate.
				["sum", `sum by (project_id) (sum_over_time(${TX}[300s]))`, "sum"],
				["increase", `sum by (project_id) (sum_over_time(${TX}[300s]))`, "sum"],
				["rate", `sum by (project_id) (sum_over_time(${TX}[300s])) / 300`, "sum"],
				["count", `sum by (project_id) (count_over_time(${TX}[300s]))`, "sum"],
				["max", `max by (project_id) (max_over_time(${TX}[300s]))`, "max"],
			],
			300,
		))

	describe("CUMULATIVE", () => {
		// A 60 s step reads two minutes, so the window holds two samples.
		cases(coreUsage, [
			["rate", `sum by (project_id) (rate(${CORE}[120s]))`, "sum"],
			["increase", `sum by (project_id) (rate(${CORE}[120s])) * 60`, "sum"],
			["sum", `sum by (project_id) (rate(${CORE}[120s])) * 60`, "sum"],
			["count", `sum by (project_id) (count_over_time(${CORE}[60s]))`, "sum"],
			["max", `max by (project_id) (max_over_time(${CORE}[60s]))`, "max"],
		])
		it.effect("reads a step wider than two minutes as its own window", () =>
			Effect.gen(function* () {
				assert.strictEqual(
					yield* query(coreUsage, "increase", { windowSeconds: 300 }),
					`sum by (project_id) (rate(${CORE}[300s])) * 300`,
				)
			}),
		)
	})

	describe("DISTRIBUTION", () => {
		it.effect("averages as the sum over the count, both kept per group and project", () =>
			Effect.gen(function* () {
				assert.deepStrictEqual(yield* compile(latencies, "avg", { groupLabel: "method" }), {
					query: avgParts(
						`sum by (method, project_id) (sum_over_time(${LAT("sum")}[60s]))`,
						`sum by (method, project_id) (sum_over_time(${LAT("count")}[60s]))`,
					),
					merge: "avg",
				})
			}),
		)
		it.effect("sums the _sum series and counts the _count series", () =>
			Effect.gen(function* () {
				assert.strictEqual(
					yield* query(latencies, "sum"),
					`sum by (project_id) (sum_over_time(${LAT("sum")}[60s]))`,
				)
				assert.strictEqual(
					yield* query(latencies, "count"),
					`sum by (project_id) (sum_over_time(${LAT("count")}[60s]))`,
				)
			}),
		)
		it.effect("rates a delta _count per second of the window", () =>
			Effect.gen(function* () {
				assert.strictEqual(
					yield* query(latencies, "rate"),
					`sum by (project_id) (sum_over_time(${LAT("count")}[60s])) / 60`,
				)
			}),
		)
		it.effect("rates a cumulative _count and sums it as rate times the step", () =>
			Effect.gen(function* () {
				const cumulative = { ...latencies, metricKind: "CUMULATIVE" as const }
				assert.strictEqual(
					yield* query(cumulative, "rate"),
					`sum by (project_id) (rate(${LAT("count")}[120s]))`,
				)
				assert.strictEqual(
					yield* query(cumulative, "sum"),
					`sum by (project_id) (rate(${LAT("sum")}[120s])) * 60`,
				)
			}),
		)
		for (const metric of ["min", "max"] as const) {
			it.effect(`refuses ${metric}`, () =>
				Effect.gen(function* () {
					assert.include(yield* rejection(latencies, metric), `${metric} is not available`)
				}),
			)
		}
	})

	it.effect("groups by the flat label and project, quoting names PromQL cannot spell bare", () =>
		Effect.gen(function* () {
			assert.strictEqual(
				yield* query(transactions, "sum", { groupLabel: "database_id" }),
				`sum by (database_id, project_id) (sum_over_time(${TX}[60s]))`,
			)
			assert.strictEqual(
				yield* query(cpu, "max", { groupLabel: "k8s.pod.name" }),
				`max by ("k8s.pod.name", project_id) (max_over_time(${CPU}[60s]))`,
			)
			assert.strictEqual(
				yield* query(cpu, "max", { groupLabel: "project_id" }),
				`max by (project_id) (max_over_time(${CPU}[60s]))`,
			)
		}),
	)

	it.effect("refuses values PromQL cannot chart", () =>
		Effect.gen(function* () {
			assert.include(yield* rejection({ ...cpu, valueType: "STRING" }, "avg"), "cannot be charted")
		}),
	)

	it.effect("refuses service.name and deployment.environment filters", () =>
		Effect.gen(function* () {
			assert.include(
				yield* rejection(cpu, "avg", { filters: { serviceName: ServiceName.make("api") } }),
				"no service.name",
			)
			assert.include(
				yield* rejection(cpu, "avg", {
					filters: { environments: [DeploymentEnvironment.make("production")] },
				}),
				"no deployment.environment",
			)
		}),
	)

	describe("monitored_resource", () => {
		const entries = descriptor({
			type: "logging.googleapis.com/log_entry_count",
			metricKind: "DELTA",
			valueType: "INT64",
			monitoredResourceTypes: ["gce_instance", "k8s_container"],
		})
		const entriesIn = (type: string) =>
			`sum_over_time({"logging.googleapis.com/log_entry_count", monitored_resource="${type}"}[60s])`

		it.effect("unions one exact selector per listed resource type inside the aggregation", () =>
			Effect.gen(function* () {
				assert.strictEqual(
					yield* query(entries, "sum", { groupLabel: "severity" }),
					`sum by (severity, project_id) (${entriesIn("gce_instance")} or ${entriesIn("k8s_container")})`,
				)
			}),
		)

		it.effect("uses a monitored_resource equals filter instead of the listed types", () =>
			Effect.gen(function* () {
				assert.strictEqual(
					yield* query(entries, "sum", {
						filters: {
							resourceAttributeFilters: [
								{ key: "monitored_resource", mode: "equals", value: "k8s_container" },
							],
						},
					}),
					`sum by (project_id) (${entriesIn("k8s_container")})`,
				)
			}),
		)

		it.effect("asks for a monitored_resource filter when Google lists no type", () =>
			Effect.gen(function* () {
				const unlisted = { ...entries, monitoredResourceTypes: [] }
				assert.include(yield* rejection(unlisted, "sum"), "filter on monitored_resource")
				assert.strictEqual(
					yield* query(unlisted, "sum", {
						filters: {
							resourceAttributeFilters: [
								{ key: "monitored_resource", mode: "equals", value: "gce_instance" },
							],
						},
					}),
					`sum by (project_id) (${entriesIn("gce_instance")})`,
				)
			}),
		)
	})

	describe("filters", () => {
		const matchers = (filters: ReadonlyArray<AttributeFilter>) =>
			query(cpu, "max", withFilters(filters)).pipe(
				Effect.map((promQl) =>
					promQl.slice(
						`max by (project_id) (max_over_time({"cloudsql.googleapis.com/database/cpu/utilization", monitored_resource="cloudsql_database", `
							.length,
						-"}[60s]))".length,
					),
				),
			)

		it.effect("lowers equals, in, contains and exists", () =>
			Effect.gen(function* () {
				assert.strictEqual(
					yield* matchers([{ key: "database_id", mode: "equals", value: "p:db" }]),
					`database_id="p:db"`,
				)
				assert.strictEqual(
					yield* matchers([{ key: "database_id", mode: "equals", value: "p:db", negated: true }]),
					`database_id!="p:db"`,
				)
				assert.strictEqual(
					yield* matchers([{ key: "region", mode: "in", values: ["us-east1", "eu.west"] }]),
					`region=~"(?:us-east1|eu\\\\.west)"`,
				)
				assert.strictEqual(
					yield* matchers([{ key: "region", mode: "in", values: ["a"], negated: true }]),
					`region!~"(?:a)"`,
				)
				assert.strictEqual(
					yield* matchers([{ key: "region", mode: "contains", value: "us" }]),
					`region=~".*us.*"`,
				)
				assert.strictEqual(yield* matchers([{ key: "region", mode: "exists" }]), `region=~".+"`)
				assert.strictEqual(
					yield* matchers([{ key: "region", mode: "exists", negated: true }]),
					`region=""`,
				)
			}),
		)

		it.effect("escapes string values and regex metacharacters", () =>
			Effect.gen(function* () {
				assert.strictEqual(
					yield* matchers([{ key: "query", mode: "equals", value: 'say "hi"\\\nbye' }]),
					`query="say \\"hi\\"\\\\\\nbye"`,
				)
				assert.strictEqual(
					yield* matchers([{ key: "query", mode: "contains", value: "a+b(c)" }]),
					`query=~".*a\\\\+b\\\\(c\\\\).*"`,
				)
				assert.strictEqual(
					yield* matchers([{ key: "cloud.region", mode: "equals", value: "x" }]),
					`"cloud.region"="x"`,
				)
			}),
		)

		it.effect("folds an OR group of equals/in on one label into one regex", () =>
			Effect.gen(function* () {
				assert.strictEqual(
					yield* matchers([
						{
							key: "state",
							mode: "equals",
							value: "idle",
							or: [{ key: "state", mode: "in", values: ["active", "waiting"] }],
						},
					]),
					`state=~"(?:idle|active|waiting)"`,
				)
			}),
		)

		it.effect("refuses OR groups across labels and numeric comparisons", () =>
			Effect.gen(function* () {
				assert.include(
					yield* rejection(
						cpu,
						"avg",
						withFilters([
							{
								key: "a",
								mode: "equals",
								value: "1",
								or: [{ key: "b", mode: "equals", value: "2" }],
							},
						]),
					),
					"OR filters",
				)
				assert.include(
					yield* rejection(cpu, "avg", withFilters([{ key: "a", mode: "gt", value: "1" }])),
					"Google Cloud labels are strings",
				)
			}),
		)

		it.effect("refuses an in filter without values, which ClickHouse would match nothing with", () =>
			Effect.gen(function* () {
				assert.include(
					yield* rejection(cpu, "avg", withFilters([{ key: "region", mode: "in", values: [] }])),
					"in filter on region",
				)
				assert.include(
					yield* rejection(
						cpu,
						"avg",
						withFilters([
							{
								key: "region",
								mode: "equals",
								value: "a",
								or: [{ key: "region", mode: "in", values: [] }],
							},
						]),
					),
					"in filter on region",
				)
			}),
		)
	})
})

describe("gcpFilterProjects", () => {
	const projects = (attributeFilters: ReadonlyArray<AttributeFilter>) =>
		gcpFilterProjects({ metricName: MetricName.make(cpu.type), metricType: "gauge", attributeFilters })

	it("narrows to the projects a positive equals or in filter names", () => {
		assert.deepStrictEqual(projects([{ key: "project_id", mode: "in", values: ["alpha", "beta"] }]), [
			"alpha",
			"beta",
		])
		assert.deepStrictEqual(projects([{ key: "project_id", mode: "equals", value: "alpha" }]), ["alpha"])
	})

	it("reads every project for a negated, contains, OR or absent project filter", () => {
		for (const filters of [
			[{ key: "project_id", mode: "equals", value: "alpha", negated: true }],
			[{ key: "project_id", mode: "contains", value: "alp" }],
			[
				{
					key: "project_id",
					mode: "equals",
					value: "alpha",
					or: [{ key: "region", mode: "equals", value: "eu" }],
				},
			],
			[{ key: "region", mode: "equals", value: "eu" }],
		] satisfies ReadonlyArray<ReadonlyArray<AttributeFilter>>) {
			assert.isUndefined(projects(filters))
		}
	})
})

describe("compileGcpSampleCount", () => {
	it.effect("counts a distribution's samples on its _count series, not its observations", () =>
		Effect.gen(function* () {
			const compiled = yield* compileGcpSampleCount(
				request(latencies, "avg", { groupLabel: "method", windowSeconds: 300 }),
				latencies,
			)
			assert.deepStrictEqual(compiled, {
				query: `sum by (method, project_id) (count_over_time(${LAT("count")}[300s]))`,
				merge: "sum",
			})
		}),
	)

	it.effect("counts a plain metric's samples", () =>
		Effect.gen(function* () {
			const compiled = yield* compileGcpSampleCount(request(cpu, "avg"), cpu)
			assert.strictEqual(compiled.query, `sum by (project_id) (count_over_time(${CPU}[60s]))`)
		}),
	)
})

describe("discovery", () => {
	it.effect("counts series per label value and project", () =>
		Effect.gen(function* () {
			assert.strictEqual(
				yield* compileGcpLabelValues(cpu, "database_id", 86400),
				`count by (database_id, project_id) (last_over_time(${CPU}[86400s]))`,
			)
		}),
	)
})

describe("bucket alignment", () => {
	const at = (iso: string) => Date.parse(iso)

	it("evaluates from the first bucket's end to the last bucket's end", () => {
		const window = gcpRangeWindow(at("2026-10-19T10:02:30Z"), at("2026-10-19T10:30:10Z"), 300)
		assert.deepStrictEqual(window, {
			stepSeconds: 300,
			startSeconds: at("2026-10-19T10:05:00Z") / 1000,
			endSeconds: at("2026-10-19T10:35:00Z") / 1000,
		})
	})

	it("labels a point by the bucket it closes", () =>
		assert.strictEqual(
			gcpPointBucket(at("2026-10-19T10:05:00Z") / 1000, 300),
			"2026-10-19T10:00:00.000Z",
		))

	it("never steps below Google's one-minute sample period", () =>
		assert.strictEqual(gcpRangeWindow(0, 600_000, 15).stepSeconds, 60))
})
