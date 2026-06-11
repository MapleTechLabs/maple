import { describe, expect, it } from "vitest"
import { compileCH } from "../compile"
import {
	anomalyErrorSpikeBaselineQuery,
	anomalyErrorSpikeCurrentQuery,
	anomalyLogVolumeQuery,
	anomalyTraceSignalsQuery,
	matchedHoursOfDay,
} from "./anomaly"

const baseParams = {
	orgId: "org_1",
	startTime: "2024-01-01 00:00:00",
	endTime: "2024-01-08 00:00:00",
}

describe("matchedHoursOfDay", () => {
	it("returns hour ±1", () => {
		expect(matchedHoursOfDay(14)).toEqual([13, 14, 15])
	})

	it("wraps at midnight", () => {
		expect(matchedHoursOfDay(0)).toEqual([23, 0, 1])
		expect(matchedHoursOfDay(23)).toEqual([22, 23, 0])
	})
})

describe("anomalyTraceSignalsQuery", () => {
	it("reads the hourly MV with entry-point + matched-hour filters", () => {
		const q = anomalyTraceSignalsQuery({ hoursOfDay: matchedHoursOfDay(14) })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM traces_aggregates_hourly")
		expect(sql).toContain("IsEntryPoint = 1")
		expect(sql).toContain("toHour(Hour) IN (13, 14, 15)")
		expect(sql).toContain("sum(WeightedCount) AS requestCount")
		expect(sql).toContain("sum(WeightedErrorCount) AS errorCount")
		expect(sql).toContain("quantilesTDigestWeightedMerge(0.95)(DurationQuantiles)")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("GROUP BY serviceName, deploymentEnv, hour")
		expect(sql).toContain("LIMIT 25000")
	})
})

describe("anomalyLogVolumeQuery", () => {
	it("reads logs_aggregates_hourly with severity-class sums", () => {
		const q = anomalyLogVolumeQuery({ hoursOfDay: matchedHoursOfDay(0) })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM logs_aggregates_hourly")
		expect(sql).toContain("toHour(Hour) IN (23, 0, 1)")
		expect(sql).toContain("sumIf(Count, lower(SeverityText) IN ('error', 'fatal', 'critical'))")
		expect(sql).toContain("sumIf(Count, lower(SeverityText) IN ('warn', 'warning'))")
		expect(sql).toContain("OrgId = 'org_1'")
	})
})

describe("anomalyErrorSpikeCurrentQuery", () => {
	it("reads the time-ordered error events sibling grouped by fingerprint", () => {
		const q = anomalyErrorSpikeCurrentQuery({})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM error_events_by_time")
		expect(sql).toContain("toString(FingerprintHash) AS fingerprintHash")
		expect(sql).toContain("GROUP BY fingerprintHash, deploymentEnv")
		expect(sql).toContain("ORDER BY count DESC")
		expect(sql).toContain("LIMIT 500")
		expect(sql).toContain("OrgId = 'org_1'")
	})
})

describe("anomalyErrorSpikeBaselineQuery", () => {
	it("compiles a two-level hourly aggregate", () => {
		const q = anomalyErrorSpikeBaselineQuery({})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM error_events_by_time")
		expect(sql).toContain("toStartOfHour(Timestamp)")
		expect(sql).toContain("count() AS hourCount")
		expect(sql).toContain("sum(hourCount) AS totalCount")
		expect(sql).toContain("quantile(0.5)(hourCount)")
		expect(sql).toContain("max(hourCount) AS maxHourly")
		expect(sql).toContain("GROUP BY fingerprintHash, deploymentEnv")
		expect(sql).toContain("LIMIT 5000")
		expect(sql).toContain("OrgId = 'org_1'")
	})
})
