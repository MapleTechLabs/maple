import { assert, describe, it } from "@effect/vitest"
import { DeploymentEnvironment, MetricName, ServiceName } from "@maple/domain"
import type { GcpMetricDescriptor } from "@maple/domain/gcp-live-metrics"
import type { AttributeFilter, MetricsFilters, MetricsMetric } from "@maple/domain/query-engine"
import { Effect } from "effect"
import {
	compileGcpLabelSample,
	compileGcpLabelValues,
	compileGcpMetricQuery,
	gcpPointBucket,
	gcpRangeWindow,
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
	Effect.runSync(compileGcpMetricQuery(request(d, metric, options), d))

const query = (d: GcpMetricDescriptor, metric: MetricsMetric, options?: CompileOptions) =>
	compile(d, metric, options).query

const rejection = (d: GcpMetricDescriptor, metric: MetricsMetric, options?: CompileOptions) =>
	Effect.runSync(Effect.flip(compileGcpMetricQuery(request(d, metric, options), d))).details.join(" ")

const withFilters = (attributeFilters: ReadonlyArray<AttributeFilter>) => ({ filters: { attributeFilters } })

const CPU = `{"cloudsql.googleapis.com/database/cpu/utilization", monitored_resource="cloudsql_database"}`
const TX = `{"cloudsql.googleapis.com/database/postgresql/transaction_count", monitored_resource="cloudsql_database"}`
const CORE = `{"kubernetes.io/container/cpu/core_usage_time", monitored_resource="k8s_container"}`
const LAT = (suffix: string) =>
	`{"serviceruntime.googleapis.com/api/request_latencies_${suffix}", monitored_resource="consumed_api"}`

describe("compileGcpMetricQuery", () => {
	describe("GAUGE", () => {
		for (const [metric, expected] of [
			["avg", `avg (avg_over_time(${CPU}[60s]))`],
			["min", `min (min_over_time(${CPU}[60s]))`],
			["max", `max (max_over_time(${CPU}[60s]))`],
			["sum", `sum (sum_over_time(${CPU}[60s]))`],
			["count", `sum (count_over_time(${CPU}[60s]))`],
			["rate", `sum (rate(${CPU}[60s]))`],
			["increase", `sum (increase(${CPU}[60s]))`],
		] as const) {
			it(metric, () => assert.strictEqual(query(cpu, metric), expected))
		}
	})

	describe("DELTA", () => {
		for (const [metric, expected] of [
			// Summing the deltas is exact; `increase` would extrapolate.
			["sum", `sum (sum_over_time(${TX}[300s]))`],
			["increase", `sum (sum_over_time(${TX}[300s]))`],
			["rate", `sum (sum_over_time(${TX}[300s])) / 300`],
			["count", `sum (count_over_time(${TX}[300s]))`],
			["avg", `avg (avg_over_time(${TX}[300s]))`],
			["min", `min (min_over_time(${TX}[300s]))`],
			["max", `max (max_over_time(${TX}[300s]))`],
		] as const) {
			it(metric, () =>
				assert.strictEqual(query(transactions, metric, { windowSeconds: 300 }), expected),
			)
		}
	})

	describe("CUMULATIVE", () => {
		for (const [metric, expected] of [
			["rate", `sum (rate(${CORE}[60s]))`],
			["increase", `sum (increase(${CORE}[60s]))`],
			["sum", `sum (increase(${CORE}[60s]))`],
			["count", `sum (count_over_time(${CORE}[60s]))`],
			["avg", `avg (avg_over_time(${CORE}[60s]))`],
			["max", `max (max_over_time(${CORE}[60s]))`],
		] as const) {
			it(metric, () => assert.strictEqual(query(coreUsage, metric), expected))
		}
	})

	describe("DISTRIBUTION", () => {
		it("averages as sum over count per group", () =>
			assert.strictEqual(
				query(latencies, "avg", { groupLabel: "method" }),
				`sum by (method) (sum_over_time(${LAT("sum")}[60s])) / sum by (method) (sum_over_time(${LAT("count")}[60s]))`,
			))
		it("sums the _sum series", () =>
			assert.strictEqual(query(latencies, "sum"), `sum (sum_over_time(${LAT("sum")}[60s]))`))
		it("counts the _count series", () =>
			assert.strictEqual(query(latencies, "count"), `sum (sum_over_time(${LAT("count")}[60s]))`))
		it("rates a delta _count per second of the window", () =>
			assert.strictEqual(query(latencies, "rate"), `sum (sum_over_time(${LAT("count")}[60s])) / 60`))
		it("rates a cumulative _count with rate and sums it with increase", () => {
			const cumulative = { ...latencies, metricKind: "CUMULATIVE" as const }
			assert.strictEqual(query(cumulative, "rate"), `sum (rate(${LAT("count")}[60s]))`)
			assert.strictEqual(query(cumulative, "sum"), `sum (increase(${LAT("sum")}[60s]))`)
		})
		for (const metric of ["min", "max"] as const) {
			it(`refuses ${metric}`, () =>
				assert.include(rejection(latencies, metric), `${metric} is not available`))
		}
	})

	it("groups by the flat label, quoting names PromQL cannot spell bare", () => {
		assert.strictEqual(
			query(transactions, "sum", { groupLabel: "database_id" }),
			`sum by (database_id) (sum_over_time(${TX}[60s]))`,
		)
		assert.strictEqual(
			query(cpu, "max", { groupLabel: "k8s.pod.name" }),
			`max by ("k8s.pod.name") (max_over_time(${CPU}[60s]))`,
		)
	})

	it("refuses values PromQL cannot chart", () =>
		assert.include(rejection({ ...cpu, valueType: "STRING" }, "avg"), "cannot be charted"))

	it("refuses service.name and deployment.environment filters", () => {
		assert.include(
			rejection(cpu, "avg", { filters: { serviceName: ServiceName.make("api") } }),
			"no service.name",
		)
		assert.include(
			rejection(cpu, "avg", { filters: { environments: [DeploymentEnvironment.make("production")] } }),
			"no deployment.environment",
		)
	})

	describe("monitored_resource", () => {
		const entries = descriptor({
			type: "logging.googleapis.com/log_entry_count",
			metricKind: "DELTA",
			valueType: "INT64",
			monitoredResourceTypes: ["gce_instance", "k8s_container"],
		})
		const entriesIn = (type: string) =>
			`sum_over_time({"logging.googleapis.com/log_entry_count", monitored_resource="${type}"}[60s])`

		it("unions one exact selector per listed resource type inside the aggregation", () =>
			assert.strictEqual(
				query(entries, "sum", { groupLabel: "severity" }),
				`sum by (severity) (${entriesIn("gce_instance")} or ${entriesIn("k8s_container")})`,
			))

		it("uses a monitored_resource equals filter instead of the listed types", () =>
			assert.strictEqual(
				query(entries, "sum", {
					filters: {
						resourceAttributeFilters: [
							{ key: "monitored_resource", mode: "equals", value: "k8s_container" },
						],
					},
				}),
				`sum (${entriesIn("k8s_container")})`,
			))

		it("asks for a monitored_resource filter when Google lists no type", () => {
			const unlisted = { ...entries, monitoredResourceTypes: [] }
			assert.include(rejection(unlisted, "sum"), "filter on monitored_resource")
			assert.strictEqual(
				query(unlisted, "sum", {
					filters: {
						resourceAttributeFilters: [
							{ key: "monitored_resource", mode: "equals", value: "gce_instance" },
						],
					},
				}),
				`sum (${entriesIn("gce_instance")})`,
			)
		})
	})

	describe("filters", () => {
		const matchers = (filters: ReadonlyArray<AttributeFilter>) =>
			query(cpu, "avg", withFilters(filters)).slice(
				`avg (avg_over_time({"cloudsql.googleapis.com/database/cpu/utilization", monitored_resource="cloudsql_database", `
					.length,
				-"}[60s]))".length,
			)

		it("lowers equals, in, contains and exists", () => {
			assert.strictEqual(
				matchers([{ key: "database_id", mode: "equals", value: "p:db" }]),
				`database_id="p:db"`,
			)
			assert.strictEqual(
				matchers([{ key: "database_id", mode: "equals", value: "p:db", negated: true }]),
				`database_id!="p:db"`,
			)
			assert.strictEqual(
				matchers([{ key: "region", mode: "in", values: ["us-east1", "eu.west"] }]),
				`region=~"(?:us-east1|eu\\\\.west)"`,
			)
			assert.strictEqual(
				matchers([{ key: "region", mode: "in", values: ["a"], negated: true }]),
				`region!~"(?:a)"`,
			)
			assert.strictEqual(
				matchers([{ key: "region", mode: "contains", value: "us" }]),
				`region=~".*us.*"`,
			)
			assert.strictEqual(matchers([{ key: "region", mode: "exists" }]), `region=~".+"`)
			assert.strictEqual(matchers([{ key: "region", mode: "exists", negated: true }]), `region=""`)
		})

		it("escapes string values and regex metacharacters", () => {
			assert.strictEqual(
				matchers([{ key: "query", mode: "equals", value: 'say "hi"\\\nbye' }]),
				`query="say \\"hi\\"\\\\\\nbye"`,
			)
			assert.strictEqual(
				matchers([{ key: "query", mode: "contains", value: "a+b(c)" }]),
				`query=~".*a\\\\+b\\\\(c\\\\).*"`,
			)
			assert.strictEqual(
				matchers([{ key: "cloud.region", mode: "equals", value: "x" }]),
				`"cloud.region"="x"`,
			)
		})

		it("folds an OR group of equals/in on one label into one regex", () =>
			assert.strictEqual(
				matchers([
					{
						key: "state",
						mode: "equals",
						value: "idle",
						or: [{ key: "state", mode: "in", values: ["active", "waiting"] }],
					},
				]),
				`state=~"(?:idle|active|waiting)"`,
			))

		it("refuses OR groups across labels and numeric comparisons", () => {
			assert.include(
				rejection(
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
				rejection(cpu, "avg", withFilters([{ key: "a", mode: "gt", value: "1" }])),
				"Google Cloud labels are strings",
			)
		})

		it("narrows the project fan-out on a project_id filter and keeps the matcher", () => {
			const compiled = compile(
				cpu,
				"avg",
				withFilters([{ key: "project_id", mode: "in", values: ["alpha", "beta"] }]),
			)
			assert.deepStrictEqual(compiled.projects, ["alpha", "beta"])
			assert.include(compiled.query, `project_id=~"(?:alpha|beta)"`)
			assert.isUndefined(compile(cpu, "avg").projects)
		})
	})
})

describe("discovery", () => {
	it("samples recent series of a distribution through its _count series", () =>
		assert.strictEqual(
			Effect.runSync(compileGcpLabelSample(latencies)),
			`topk(5, last_over_time(${LAT("count")}[1h]))`,
		))

	it("counts series per label value", () =>
		assert.strictEqual(
			Effect.runSync(compileGcpLabelValues(cpu, "database_id", 86400)),
			`count by (database_id) (last_over_time(${CPU}[86400s]))`,
		))
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
