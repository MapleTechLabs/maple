import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { compileUnionUnsafe } from "@maple-dev/effect-clickhouse"
import { signalPresenceQuery } from "./signal-presence"

const params = {
	orgId: "org_1",
	// Deliberately sub-hour: `service_usage` is keyed on top-of-hour `Hour`, so
	// the branches must floor both bounds or a partial hour vanishes.
	startTime: "2024-01-01 00:23:00",
	endTime: "2024-01-02 11:47:00",
}

describe("signalPresenceQuery", () => {
	it("reads the hourly usage rollup for traces, logs and metrics", () => {
		const { sql } = compileUnionUnsafe(signalPresenceQuery(), params)

		expect(sql).toContain("FROM service_usage")
		expect(sql).toContain("toStartOfHour(toDateTime('2024-01-01 00:23:00'))")
		expect(sql).toContain("toStartOfHour(toDateTime('2024-01-02 11:47:00'))")
		expect(sql).not.toContain("FROM traces")
		expect(sql).not.toContain("FROM logs")
	})

	it("scopes every branch to the org", () => {
		const { sql } = compileUnionUnsafe(signalPresenceQuery(), params)
		const branches = sql.split("UNION ALL")

		expect(branches).toHaveLength(5)
		for (const branch of branches) {
			expect(branch).toContain("OrgId = 'org_1'")
		}
	})

	it("gives each signal its own presence predicate", () => {
		const { sql } = compileUnionUnsafe(signalPresenceQuery(), params)

		// Without these, `min(Hour)` for logs would report the hour the org first
		// sent traces — a `service_usage` row exists for any signal that hour.
		expect(sql).toContain("TraceCount > 0")
		expect(sql).toContain("LogCount > 0")
		expect(sql).toContain("FROM session_replays")
		expect(sql).toContain("FROM product_events")
	})

	it("counts all four metric shapes as metrics", () => {
		const { sql } = compileUnionUnsafe(signalPresenceQuery(), params)

		for (const column of [
			"SumMetricCount",
			"GaugeMetricCount",
			"HistogramMetricCount",
			"ExpHistogramMetricCount",
		]) {
			expect(sql).toContain(column)
		}
	})

	it("decodes BYO-ClickHouse string-encoded counts", () => {
		const compiled = compileUnionUnsafe(signalPresenceQuery(), params)
		const rows = Effect.runSync(
			compiled.decodeRows([
				{
					signal: "logs",
					count: "412",
					firstSeen: "2024-01-01 01:00:00",
					lastSeen: "2024-01-02 11:00:00",
				},
			]),
		)

		expect(rows[0]).toEqual({
			signal: "logs",
			count: 412,
			firstSeen: "2024-01-01 01:00:00",
			lastSeen: "2024-01-02 11:00:00",
		})
	})

	it("keeps every branch group-less, so an absent signal still returns a row", () => {
		// This is the whole zero-row guarantee: callers treat a missing signal as a
		// bug rather than as "no data". A GROUP BY anywhere would break it silently.
		const { sql } = compileUnionUnsafe(signalPresenceQuery(), params)

		expect(sql).not.toContain("GROUP BY")
	})
})
