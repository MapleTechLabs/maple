import { AlertCheckDocument } from "@maple/domain/http"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { checkTimesOf } from "./view-query-time"

const NOW = Date.parse("2026-10-22T12:00:00.000Z")

const check = (minutesAgo: number, durationMs: number) =>
	Schema.decodeUnknownSync(AlertCheckDocument)({
		timestamp: new Date(NOW - minutesAgo * 60_000).toISOString(),
		groupKey: "__total__",
		status: "healthy",
		skipReason: null,
		signalType: "raw_query",
		comparator: "gt",
		threshold: 10,
		thresholdUpper: null,
		observedValue: 1,
		sampleCount: 1,
		windowMinutes: 5,
		windowStart: new Date(NOW - (minutesAgo + 5) * 60_000).toISOString(),
		windowEnd: new Date(NOW - minutesAgo * 60_000).toISOString(),
		consecutiveBreaches: 0,
		consecutiveHealthy: 1,
		incidentId: null,
		incidentTransition: "none",
		level: null,
		evaluationDurationMs: durationMs,
		errorMessage: null,
		errorCategory: null,
	})

describe("checkTimesOf", () => {
	it("keeps older timed checks when the newest ones were never timed", () => {
		// Newest first, as the checks list arrives: 60 untimed, then 2 timed.
		const checks = [
			...Array.from({ length: 60 }, (_, i) => check(i + 1, 0)),
			check(100, 2_000),
			check(101, 3_000),
		]
		expect(checkTimesOf(checks).map((time) => time.durationMs)).toEqual([3_000, 2_000])
	})
})
