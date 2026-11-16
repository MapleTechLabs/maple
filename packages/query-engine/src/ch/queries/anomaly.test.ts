import { describe, expect, it } from "vitest"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import {
	anomalyErrorSpikeBaselineQuery,
	anomalyErrorSpikeCurrentQuery,
	anomalyErrorSpikeTimeseriesQuery,
	anomalyLogVolumeQuery,
	anomalyLogVolumeTimeseriesQuery,
	anomalyTraceSignalsQuery,
	anomalyTraceSignalsWindowQuery,
	anomalyTraceSignalTimeseriesQuery,
} from "./anomaly"
import { OrgId } from "@maple/domain"

const baseParams = {
	orgId: OrgId.make("org_1"),
	startTime: "2024-01-01 00:00:00",
	endTime: "2024-01-08 00:00:00",
}

describe("anomalyTraceSignalsQuery", () => {
	it("reads the hourly entry-point rollup on the requested hours of day", () => {
		const q = anomalyTraceSignalsQuery({ hoursOfDay: [12, 13, 14, 15] })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("FROM service_overview_hourly")
		expect(sql).toContain("toHour(service_overview_hourly.Hour) IN (12, 13, 14, 15)")
		expect(sql).toContain("quantilesTDigestMerge(0.5, 0.95, 0.99)(DurationQuantiles), 2)")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("GROUP BY serviceName, deploymentEnv, hour")
		expect(sql).toContain("LIMIT 25000")
	})
})

describe("anomalyTraceSignalsWindowQuery", () => {
	it("reads the minutely twin over a half-open window, one row per series", () => {
		const { sql } = compileUnsafe(anomalyTraceSignalsWindowQuery(), baseParams)
		expect(sql).toContain("FROM service_overview_minutely")
		expect(sql).toMatch(/Minute >= .*2024-01-01 00:00:00/)
		expect(sql).toMatch(/Minute < .*2024-01-08 00:00:00/)
		expect(sql).toContain("GROUP BY serviceName, deploymentEnv")
		expect(sql).toContain("OrgId = 'org_1'")
	})
})

describe("anomalyLogVolumeQuery", () => {
	it("reads logs_aggregates_hourly with severity-class sums", () => {
		const q = anomalyLogVolumeQuery({ hoursOfDay: [23, 0, 1] })
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("FROM logs_aggregates_hourly")
		expect(sql).toContain("toHour(logs_aggregates_hourly.Hour) IN (23, 0, 1)")
		expect(sql).toContain(
			"sumIf(logs_aggregates_hourly.Count, lower(logs_aggregates_hourly.SeverityText) IN ('error', 'fatal', 'critical'))",
		)
		expect(sql).toContain(
			"sumIf(logs_aggregates_hourly.Count, lower(logs_aggregates_hourly.SeverityText) IN ('warn', 'warning'))",
		)
		expect(sql).toContain("OrgId = 'org_1'")
	})
})

describe("anomalyErrorSpikeCurrentQuery", () => {
	it("reads the time-ordered error events sibling grouped by fingerprint", () => {
		const q = anomalyErrorSpikeCurrentQuery({})
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("FROM error_events_by_time")
		expect(sql).toContain("toString(error_events_by_time.FingerprintHash) AS fingerprintHash")
		expect(sql).toContain("GROUP BY fingerprintHash, deploymentEnv")
		expect(sql).toContain("ORDER BY count DESC")
		expect(sql).toContain("LIMIT 500")
		expect(sql).toContain("OrgId = 'org_1'")
	})
})

describe("anomalyErrorSpikeBaselineQuery", () => {
	it("compiles a two-level hourly aggregate", () => {
		const q = anomalyErrorSpikeBaselineQuery({})
		const { sql } = compileUnsafe(q, baseParams)
		expect(sql).toContain("FROM error_events_by_time")
		expect(sql).toContain("toStartOfHour(error_events_by_time.Timestamp)")
		expect(sql).toContain("count() AS hourCount")
		expect(sql).toContain("sum(hourly.hourCount) AS totalCount")
		expect(sql).toContain("quantile(0.5)(hourly.hourCount)")
		expect(sql).toContain("max(hourly.hourCount) AS maxHourly")
		expect(sql).toContain("GROUP BY fingerprintHash, deploymentEnv")
		expect(sql).toContain("LIMIT 5000")
		expect(sql).toContain("OrgId = 'org_1'")
	})
})

const seriesParams = {
	...baseParams,
	serviceName: "checkout",
	deploymentEnv: "prod",
}

describe("anomalyTraceSignalTimeseriesQuery", () => {
	it("returns a continuous hourly window for one service/env series", () => {
		const q = anomalyTraceSignalTimeseriesQuery()
		const { sql } = compileUnsafe(q, seriesParams)
		// The rollup the detector reads, so the chart plots the series it judged.
		expect(sql).toContain("FROM service_overview_hourly")
		expect(sql).toContain("ServiceName = 'checkout'")
		expect(sql).toContain("DeploymentEnv = 'prod'")
		expect(sql).toContain("OrgId = 'org_1'")
		// No matched-hours filter — the chart wants every bucket in the window.
		expect(sql).not.toContain("toHour(Hour)")
		expect(sql).toContain("GROUP BY hour")
		expect(sql).toContain("ORDER BY hour ASC")
		expect(sql).toContain("LIMIT 200")
	})
})

describe("anomalyLogVolumeTimeseriesQuery", () => {
	it("returns hourly error-log volume for one service/env series", () => {
		const q = anomalyLogVolumeTimeseriesQuery()
		const { sql } = compileUnsafe(q, seriesParams)
		expect(sql).toContain("FROM logs_aggregates_hourly")
		expect(sql).toContain(
			"sumIf(logs_aggregates_hourly.Count, lower(logs_aggregates_hourly.SeverityText) IN ('error', 'fatal', 'critical'))",
		)
		expect(sql).toContain("ServiceName = 'checkout'")
		expect(sql).toContain("DeploymentEnv = 'prod'")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).not.toContain("toHour(Hour)")
		expect(sql).toContain("ORDER BY hour ASC")
	})
})

describe("anomalyErrorSpikeTimeseriesQuery", () => {
	it("buckets one fingerprint/env series by interval", () => {
		const q = anomalyErrorSpikeTimeseriesQuery()
		const { sql } = compileUnsafe(q, {
			...baseParams,
			fingerprintHash: "12345",
			deploymentEnv: "prod",
			bucketSeconds: 300,
		})
		// The fingerprint-sorted table, not its time-sorted sibling.
		expect(sql).toContain("FROM error_events\n")
		expect(sql).not.toContain("error_events_by_time")
		expect(sql).toContain("toStartOfInterval(error_events.Timestamp, INTERVAL 300 SECOND)")
		expect(sql).toContain("FingerprintHash = toUInt64('12345')")
		expect(sql).toContain("DeploymentEnv = 'prod'")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("GROUP BY bucket")
		expect(sql).toContain("ORDER BY bucket ASC")
		expect(sql).toContain("LIMIT 2500")
	})
})
