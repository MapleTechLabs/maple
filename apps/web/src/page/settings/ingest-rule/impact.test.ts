import { describe, expect, test } from "vitest"
import { V2IngestRuleStats } from "@maple/domain/http/v2"
import { Array as Arr, Schema } from "effect"
import { bucketed, hourlySeries, hourWindow } from "./impact"

describe("impact windows", () => {
	test("end on the next hour, so every bucket in the window is whole", () => {
		expect(hourWindow(Date.UTC(2026, 10, 23, 12, 45), 24)).toEqual({
			start_time: "2026-11-22T13:00:00.000Z",
			end_time: "2026-11-23T13:00:00.000Z",
		})
		expect(hourWindow(Date.UTC(2026, 10, 23, 13), 1)).toEqual({
			start_time: "2026-11-23T13:00:00.000Z",
			end_time: "2026-11-23T14:00:00.000Z",
		})
	})
})

describe("hourly series", () => {
	const stats = (endTime: string, buckets: ReadonlyArray<readonly [string, number]>) =>
		Schema.decodeSync(V2IngestRuleStats)({
			object: "ingest_rule_stats",
			start_time: "2026-11-22T13:00:00.000Z",
			end_time: endTime,
			rules: [],
			signals: [],
			hourly: Arr.map(buckets, ([bucket, dropped]) => ({
				id: RULE,
				bucket,
				matched: dropped,
				dropped,
				dropped_bytes: 0,
				redacted_values: 0,
			})),
		})
	const RULE = "irule_YofPTrK9782DWwcnXhpcCw"

	test("an end on the hour leaves that hour out; the newest bucket is the hour before it", () => {
		const decoded = stats("2026-11-23T13:00:00.000Z", [
			["2026-11-23T12:00:00.000Z", 5],
			["2026-11-22T13:00:00.000Z", 1],
			["2026-11-23T13:00:00.000Z", 99],
		])
		const series = hourlySeries(decoded, decoded.hourly[0]?.id ?? "", 24, (entry) => entry.dropped)
		expect(series).toHaveLength(24)
		expect(series[23]).toBe(5)
		expect(series[0]).toBe(1)
		expect(Arr.reduce(series, 0, (total, value) => total + value)).toBe(6)
	})

	test("an end mid-hour keeps the current, partial hour as the newest bucket", () => {
		const decoded = stats("2026-11-23T12:45:00.000Z", [["2026-11-23T12:00:00.000Z", 7]])
		const series = hourlySeries(decoded, decoded.hourly[0]?.id ?? "", 24, (entry) => entry.dropped)
		expect(series[23]).toBe(7)
	})

	test("six-hour bars sum whole groups of hours", () => {
		expect(
			bucketed(
				Arr.makeBy(12, (index) => index),
				6,
			),
		).toEqual([15, 51])
	})
})
