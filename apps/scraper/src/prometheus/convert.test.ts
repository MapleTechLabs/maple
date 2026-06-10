import { getColumnJsonPath, type DatasourceDefinition } from "@tinybirdco/sdk"
import { metricsGauge, metricsHistogram, metricsSum } from "@maple/domain/tinybird"
import { describe, expect, it } from "vitest"
import { convertFamiliesToRows, EPOCH_TIMESTAMP, formatTimestampMs, type ScrapeRowContext } from "./convert"
import { parsePrometheusText } from "./parser"

const ctx: ScrapeRowContext = {
	orgId: "org_test",
	targetId: "11111111-1111-4111-8111-111111111111",
	targetName: "Node Exporter",
	serviceName: "node",
	instance: "node.example.com:9100",
	targetLabels: { env: "prod" },
	scrapeTimeMs: 1750000000000, // 2025-06-15T15:06:40.000Z
}

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{9}$/

const convert = (body: string) => convertFamiliesToRows(parsePrometheusText(body).families, ctx)

/** Top-level NDJSON keys a datasource ingests, derived from its jsonPaths. */
const ingestedKeys = (datasource: DatasourceDefinition): Set<string> => {
	const keys = new Set<string>()
	for (const column of Object.values(datasource.options.schema)) {
		const path = getColumnJsonPath(column)
		if (!path || !path.startsWith("$.")) continue
		const head = path.slice(2).split(/[.\[]/, 1)[0]
		if (head) keys.add(head)
	}
	return keys
}

describe("datasource compatibility", () => {
	const body = [
		"# TYPE c counter",
		"c_total 1",
		"# TYPE g gauge",
		"g 2",
		"# TYPE h histogram",
		'h_bucket{le="1"} 1',
		'h_bucket{le="+Inf"} 2',
		"h_sum 1.5",
		"h_count 2",
	].join("\n")

	const cases: Array<{ name: string; datasource: DatasourceDefinition; rows: ReadonlyArray<Record<string, unknown>> }> = [
		{ name: "metrics_sum", datasource: metricsSum, rows: convert(body).sum },
		{ name: "metrics_gauge", datasource: metricsGauge, rows: convert(body).gauge },
		{ name: "metrics_histogram", datasource: metricsHistogram, rows: convert(body).histogram },
	]

	for (const { name, datasource, rows } of cases) {
		it(`emits exactly the NDJSON keys ${name} ingests (jsonPath contract)`, () => {
			expect(rows.length).toBeGreaterThan(0)
			const expected = ingestedKeys(datasource)
			for (const row of rows) {
				const actual = new Set(Object.keys(row))
				const extra = [...actual].filter((key) => !expected.has(key)).sort()
				const missing = [...expected].filter((key) => !actual.has(key)).sort()
				expect(extra, `${name}: keys not ingested by the datasource`).toEqual([])
				expect(missing, `${name}: ingested columns left unset`).toEqual([])
			}
		})

		it(`serializes ${name} rows as valid JSON (no NaN/Infinity leakage)`, () => {
			for (const row of rows) {
				const roundTripped = JSON.parse(JSON.stringify(row)) as Record<string, unknown>
				expect(roundTripped).toEqual(row)
			}
		})
	}
})

describe("convertFamiliesToRows", () => {
	it("converts counters to cumulative monotonic sum rows", () => {
		const { sum } = convert('# TYPE requests counter\nrequests_total{code="200"} 100')
		expect(sum).toHaveLength(1)
		const row = sum[0]!
		expect(row.metric_name).toBe("requests_total")
		expect(row.value).toBe(100)
		expect(row.aggregation_temporality).toBe(2)
		expect(row.is_monotonic).toBe(true)
		expect(row.service_name).toBe("node")
		expect(row.start_timestamp).toBe(EPOCH_TIMESTAMP)
		expect(row.timestamp).toMatch(TIMESTAMP_RE)
	})

	it("stamps tenant attribution and scrape provenance into resource_attributes", () => {
		const { gauge } = convert("# TYPE up gauge\nup 1")
		expect(gauge[0]?.resource_attributes).toEqual({
			maple_org_id: "org_test",
			maple_ingest_source: "prometheus-scrape",
			maple_ingest_key_type: "internal",
			maple_scrape_target_id: "11111111-1111-4111-8111-111111111111",
			maple_scrape_target_name: "Node Exporter",
			"service.name": "node",
		})
	})

	it("merges target labels and sample labels, system labels win", () => {
		const { gauge } = convert(
			'# TYPE g gauge\ng{job="evil-job",instance="evil-host",env="staging",custom="yes"} 1',
		)
		expect(gauge[0]?.metric_attributes).toEqual({
			env: "staging", // sample label overrides target label
			custom: "yes",
			job: "node", // system label wins over scraped `job`
			instance: "node.example.com:9100",
		})
	})

	it("uses the sample timestamp when present, scrape time otherwise", () => {
		const { gauge } = convert("# TYPE g gauge\ng{a=\"1\"} 1 1712345678901\ng{a=\"2\"} 2")
		expect(gauge[0]?.timestamp).toBe(formatTimestampMs(1712345678901))
		expect(gauge[1]?.timestamp).toBe(formatTimestampMs(ctx.scrapeTimeMs))
	})

	it("de-cumulates histogram buckets and excludes +Inf from explicit_bounds", () => {
		const { histogram } = convert(
			[
				"# TYPE lat histogram",
				'lat_bucket{le="0.1"} 1',
				'lat_bucket{le="1"} 4',
				'lat_bucket{le="5"} 9',
				'lat_bucket{le="+Inf"} 10',
				"lat_sum 42.5",
				"lat_count 10",
			].join("\n"),
		)
		expect(histogram).toHaveLength(1)
		const row = histogram[0]!
		expect(row.metric_name).toBe("lat")
		expect(row.explicit_bounds).toEqual([0.1, 1, 5])
		expect(row.bucket_counts).toEqual([1, 3, 5, 1])
		expect(row.count).toBe(10)
		expect(row.sum).toBe(42.5)
		expect(row.min).toBeNull()
		expect(row.max).toBeNull()
		expect(row.aggregation_temporality).toBe(2)
		// bucket_counts sums to count; one more entry than bounds
		expect((row.bucket_counts as number[]).reduce((a, b) => a + b, 0)).toBe(row.count)
		expect((row.bucket_counts as number[]).length).toBe((row.explicit_bounds as number[]).length + 1)
	})

	it("groups histogram series by label set (minus le)", () => {
		const { histogram } = convert(
			[
				"# TYPE lat histogram",
				'lat_bucket{path="/a",le="1"} 2',
				'lat_bucket{path="/a",le="+Inf"} 3',
				'lat_sum{path="/a"} 1.2',
				'lat_count{path="/a"} 3',
				'lat_bucket{path="/b",le="1"} 5',
				'lat_bucket{path="/b",le="+Inf"} 5',
				'lat_sum{path="/b"} 2.5',
				'lat_count{path="/b"} 5',
			].join("\n"),
		)
		expect(histogram).toHaveLength(2)
		const byPath = Object.fromEntries(
			histogram.map((row) => [(row.metric_attributes as Record<string, string>).path, row]),
		)
		expect(byPath["/a"]?.count).toBe(3)
		expect(byPath["/a"]?.bucket_counts).toEqual([2, 1])
		expect(byPath["/b"]?.count).toBe(5)
		expect(byPath["/b"]?.bucket_counts).toEqual([5, 0])
		// `le` must not leak into attributes
		expect(byPath["/a"]?.metric_attributes).not.toHaveProperty("le")
	})

	it("clamps negative bucket deltas to zero (scrape races)", () => {
		const { histogram } = convert(
			["# TYPE lat histogram", 'lat_bucket{le="1"} 5', 'lat_bucket{le="2"} 3', 'lat_bucket{le="+Inf"} 5', "lat_count 5", "lat_sum 1"].join(
				"\n",
			),
		)
		expect(histogram[0]?.bucket_counts).toEqual([5, 0, 2])
	})

	it("falls back to the +Inf bucket when _count is missing and drops series with neither", () => {
		const withInf = convert(
			["# TYPE a histogram", 'a_bucket{le="1"} 1', 'a_bucket{le="+Inf"} 4', "a_sum 2"].join("\n"),
		)
		expect(withInf.histogram[0]?.count).toBe(4)

		const without = convert(["# TYPE b histogram", 'b_bucket{le="1"} 1', "b_sum 2"].join("\n"))
		expect(without.histogram).toEqual([])
		expect(without.droppedSeriesCount).toBe(1)
	})

	it("maps summaries to sum rows (_sum/_count) and gauge rows (quantiles)", () => {
		const { sum, gauge } = convert(
			[
				"# TYPE rpc summary",
				'rpc{quantile="0.5"} 0.05',
				'rpc{quantile="0.99"} 0.2',
				"rpc_sum 102.1",
				"rpc_count 800",
			].join("\n"),
		)
		expect(sum).toHaveLength(2)
		const sumRow = sum.find((row) => row.metric_name === "rpc_sum")!
		const countRow = sum.find((row) => row.metric_name === "rpc_count")!
		expect(sumRow.is_monotonic).toBe(false)
		expect(countRow.is_monotonic).toBe(true)
		expect(countRow.value).toBe(800)

		expect(gauge).toHaveLength(2)
		expect(gauge[0]?.metric_name).toBe("rpc")
		expect((gauge[0]?.metric_attributes as Record<string, string>).quantile).toBe("0.5")
	})

	it("drops non-finite values and counts them", () => {
		const result = convert(
			[
				"# TYPE c counter",
				"c_total NaN",
				"# TYPE g gauge",
				"g{kind=\"nan\"} NaN",
				"g{kind=\"inf\"} +Inf",
				"g{kind=\"ok\"} 1",
				"# TYPE s summary",
				's{quantile="0.5"} NaN',
				"s_sum 10",
				"s_count 5",
			].join("\n"),
		)
		expect(result.sum.map((row) => row.metric_name).sort()).toEqual(["s_count", "s_sum"])
		expect(result.gauge).toHaveLength(1)
		expect(result.gauge[0]?.value).toBe(1)
		expect(result.droppedSeriesCount).toBe(4)
	})

	it("propagates HELP and UNIT into description and unit", () => {
		const { sum } = convert(
			["# TYPE x counter", "# HELP x Things counted.", "# UNIT x things", "x_total 1"].join("\n"),
		)
		expect(sum[0]?.metric_description).toBe("Things counted.")
		expect(sum[0]?.metric_unit).toBe("things")
	})
})

describe("formatTimestampMs", () => {
	it("formats epoch ms as dateTime64(9) ingest shape", () => {
		expect(formatTimestampMs(0)).toBe("1970-01-01 00:00:00.000000000")
		expect(formatTimestampMs(1712345678901)).toBe("2024-04-05 19:34:38.901000000")
		expect(formatTimestampMs(1712345678901)).toMatch(TIMESTAMP_RE)
		expect(EPOCH_TIMESTAMP).toMatch(TIMESTAMP_RE)
	})
})
