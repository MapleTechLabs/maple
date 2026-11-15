import { describe, expect, it } from "vitest"
import { generateDemoRows } from "./fixtures"
import { Effect, Random, Array as Arr, String as Str } from "effect"

describe("generateDemoRows metrics", () => {
	const rows = Effect.runSync(
		Effect.gen(function* () {
			const random = yield* Random.Random
			return generateDemoRows({
				orgId: "org_test",
				hours: 2,
				ratePerHour: 10,
				random: () => random.nextDoubleUnsafe(),
			})
		}).pipe(Random.withSeed("demo-fixtures")),
	)

	it("emits runtime gauge and sum metrics alongside traces/logs", () => {
		expect(rows.metricGaugeRows.length).toBeGreaterThan(0)
		expect(rows.metricSumRows.length).toBeGreaterThan(0)
		// The demo dashboards chart these by name.
		expect(Arr.map(rows.metricGaugeRows, (r) => r.metric_name)).toEqual(
			expect.arrayContaining([
				"process.runtime.nodejs.memory.heap.used",
				"process.runtime.nodejs.handles",
				"process.runtime.nodejs.eventloop.lag",
			]),
		)
		expect(Arr.map(rows.metricSumRows, (r) => r.metric_name)).toContain("process.runtime.nodejs.gc.count")
	})

	it("scopes every metric row to the org (maple_org_id drives OrgId)", () => {
		for (const row of [...rows.metricGaugeRows, ...rows.metricSumRows]) {
			expect(row.resource_attributes.maple_org_id).toBe("org_test")
			expect(["demo-api", "demo-worker"]).toContain(row.service_name)
		}
	})

	it("marks sums as cumulative monotonic counters with non-decreasing values per service", () => {
		const byService = new Map<string, number[]>()
		for (const row of rows.metricSumRows) {
			expect(row.aggregation_temporality).toBe(2)
			expect(row.is_monotonic).toBe(true)
			const list = byService.get(row.service_name) ?? []
			list.push(row.value)
			byService.set(row.service_name, list)
		}
		for (const [service, values] of byService) {
			for (let i = 1; i < values.length; i++) {
				expect(values[i], `${service} gc.count at ${i}`).toBeGreaterThanOrEqual(values[i - 1])
			}
		}
	})

	it("exports request durations as a cumulative histogram whose buckets add up to its count", () => {
		const rowsOf = (service: string) =>
			Arr.filter(rows.metricHistogramRows, (row) => row.service_name === service)
		for (const service of ["demo-api", "demo-worker"]) {
			const samples = rowsOf(service)
			expect(samples.length).toBeGreaterThan(100)
			for (const [i, row] of samples.entries()) {
				expect(row.resource_attributes.maple_org_id).toBe("org_test")
				expect(row.aggregation_temporality).toBe(2)
				expect(row.bucket_counts.length).toBe(row.explicit_bounds.length + 1)
				expect(Arr.reduce(row.bucket_counts, 0, (a, b) => a + b)).toBe(row.count)
				expect(row.count).toBeGreaterThanOrEqual(samples[i - 1]?.count ?? 0)
			}
			expect(samples[samples.length - 1]?.count).toBeGreaterThan(1000)
		}
	})

	it("exports query durations as a cumulative exponential histogram that lowers its scale partway", () => {
		for (const service of ["demo-api", "demo-worker"]) {
			const samples = Arr.filter(
				rows.metricExponentialHistogramRows,
				(row) => row.service_name === service,
			)
			expect(samples.length).toBeGreaterThan(100)
			for (const [i, row] of samples.entries()) {
				const previous = samples[i - 1]
				expect(row.resource_attributes.maple_org_id).toBe("org_test")
				expect(row.aggregation_temporality).toBe(2)
				expect(Arr.reduce(row.positive_bucket_counts, 0, (a, b) => a + b)).toBe(row.count)
				expect(row.positive_bucket_counts.length).toBeLessThanOrEqual(40)
				expect(row.count).toBeGreaterThanOrEqual(previous?.count ?? 0)
				// A running histogram only ever loses resolution.
				expect(row.scale).toBeLessThanOrEqual(previous?.scale ?? row.scale)
				// Every recorded value lies inside the buckets the sample declares.
				if (row.min !== null && row.max !== null) {
					const width = 2 ** -row.scale
					expect(row.min).toBeGreaterThan(2 ** (row.positive_offset * width))
					expect(row.max).toBeLessThanOrEqual(
						2 ** ((row.positive_offset + row.positive_bucket_counts.length) * width),
					)
				}
			}
			const half = Math.floor(samples.length / 2)
			expect(samples[samples.length - 1]?.scale).toBeLessThan(samples[half - 1]?.scale ?? Number.NaN)
		}
	})

	it("gives the running totals of one seed an instance of their own", () => {
		const instances = new Set(
			Arr.map(
				[...rows.metricSumRows, ...rows.metricHistogramRows, ...rows.metricExponentialHistogramRows],
				(row) => row.resource_attributes["service.instance.id"],
			),
		)
		expect(instances.size).toBe(1)
		expect([...instances][0]).toMatch(/^demo-[0-9a-f]+$/)
	})

	it("stays finite when the random source draws zero", () => {
		const zeros = generateDemoRows({ orgId: "org_test", hours: 1, ratePerHour: 2, random: () => 0 })
		for (const row of zeros.metricHistogramRows) {
			expect(Number.isFinite(row.sum)).toBe(true)
			expect(Number.isFinite(row.count)).toBe(true)
		}
	})

	it("stamps timestamps inside the seeded window (ClickHouse DateTime64 format)", () => {
		const now = Date.now()
		const windowStart = now - 2 * 3600 * 1000 - 60_000
		for (const row of rows.metricGaugeRows.slice(0, 20)) {
			expect(row.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/)
			const ms = new Date(`${Str.replace(" ", "T")(row.timestamp)}Z`).getTime()
			expect(ms).toBeGreaterThanOrEqual(windowStart)
			expect(ms).toBeLessThanOrEqual(now + 60_000)
		}
	})
})
