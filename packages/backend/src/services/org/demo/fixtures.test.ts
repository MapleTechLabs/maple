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
