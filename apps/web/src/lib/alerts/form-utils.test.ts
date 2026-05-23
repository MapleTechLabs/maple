import { describe, expect, it } from "vitest"
import {
	buildRuleRequest,
	defaultRuleForm,
	domainThresholdToForm,
	flattenAlertChartData,
	formThresholdToDomain,
	signalToQueryParams,
} from "./form-utils"

const makePoint = (bucket: string, series: Record<string, number>) => ({ bucket, series })

describe("flattenAlertChartData", () => {
	it("filters to only selected services when multiple are specified", () => {
		const points = [
			makePoint("2026-03-25 10:00:00", { "svc-a": 1.5, "svc-b": 2.0, "svc-c": 3.0 }),
			makePoint("2026-03-25 10:05:00", { "svc-a": 1.8, "svc-b": 2.5, "svc-c": 0.5 }),
		]

		const result = flattenAlertChartData(points, ["svc-a", "svc-b"])

		expect(result).toEqual([
			{ bucket: "2026-03-25 10:00:00", "svc-a": 1.5, "svc-b": 2.0 },
			{ bucket: "2026-03-25 10:05:00", "svc-a": 1.8, "svc-b": 2.5 },
		])
	})

	it("remaps series key to the service name for single service", () => {
		const points = [
			makePoint("2026-03-25 10:00:00", { "svc-a": 4.2 }),
			makePoint("2026-03-25 10:05:00", { "svc-a": 3.1 }),
		]

		const result = flattenAlertChartData(points, ["svc-a"])

		expect(result).toEqual([
			{ bucket: "2026-03-25 10:00:00", "svc-a": 4.2 },
			{ bucket: "2026-03-25 10:05:00", "svc-a": 3.1 },
		])
	})

	it("defaults to 0 when single service is missing from series", () => {
		const points = [makePoint("2026-03-25 10:00:00", { all: 5.0 })]

		const result = flattenAlertChartData(points, ["svc-a"])

		expect(result).toEqual([{ bucket: "2026-03-25 10:00:00", "svc-a": 0 }])
	})

	it("passes through all series keys when no services specified", () => {
		const points = [makePoint("2026-03-25 10:00:00", { "svc-a": 1.0, "svc-b": 2.0, "svc-c": 3.0 })]

		const result = flattenAlertChartData(points, [])

		expect(result).toEqual([{ bucket: "2026-03-25 10:00:00", "svc-a": 1.0, "svc-b": 2.0, "svc-c": 3.0 }])
	})

	it("skips selected services not present in series data", () => {
		const points = [makePoint("2026-03-25 10:00:00", { "svc-a": 1.0 })]

		const result = flattenAlertChartData(points, ["svc-a", "svc-missing"])

		expect(result).toEqual([{ bucket: "2026-03-25 10:00:00", "svc-a": 1.0 }])
	})

	it("handles empty points array", () => {
		expect(flattenAlertChartData([], ["svc-a"])).toEqual([])
		expect(flattenAlertChartData([], [])).toEqual([])
	})
})

describe("rule notes", () => {
	it("defaults to an empty note", () => {
		expect(defaultRuleForm().notes).toBe("")
	})

	it("carries a trimmed note onto the upsert request", () => {
		const request = buildRuleRequest({
			...defaultRuleForm(),
			name: "Error rate",
			notes: "  See runbook: https://wiki/incidents  ",
		})

		expect(request.notes).toBe("See runbook: https://wiki/incidents")
	})

	it("sends null when the note is blank or whitespace-only", () => {
		expect(buildRuleRequest({ ...defaultRuleForm(), name: "A", notes: "" }).notes).toBeNull()
		expect(buildRuleRequest({ ...defaultRuleForm(), name: "A", notes: "   " }).notes).toBeNull()
	})
})

describe("threshold unit conversion", () => {
	it("converts error_rate thresholds between percent (form) and ratio (domain)", () => {
		// User enters 5 (%), domain stores 0.05 (ratio) — the unit the query
		// engine emits and AlertsService compares against.
		expect(formThresholdToDomain("error_rate", "5")).toBe(0.05)
		expect(formThresholdToDomain("error_rate", "50")).toBe(0.5)
		expect(domainThresholdToForm("error_rate", 0.05)).toBe("5")
		expect(domainThresholdToForm("error_rate", 0.5)).toBe("50")
	})

	it("passes non-error_rate thresholds through unchanged", () => {
		expect(formThresholdToDomain("p95_latency", "500")).toBe(500)
		expect(domainThresholdToForm("p95_latency", 500)).toBe("500")
		expect(formThresholdToDomain("throughput", "1000")).toBe(1000)
	})

	it("stores error_rate threshold as a ratio on the upsert request", () => {
		// The default form threshold "5" must round-trip to the 0.05 ratio the
		// MCP tool also uses — so a default error-rate alert can actually fire.
		const request = buildRuleRequest({
			...defaultRuleForm(),
			name: "Error rate",
			signalType: "error_rate",
		})
		expect(request.threshold).toBe(0.05)
	})

	it("keeps latency thresholds in their native units on the upsert request", () => {
		const request = buildRuleRequest({
			...defaultRuleForm(),
			name: "P95",
			signalType: "p95_latency",
			threshold: "500",
		})
		expect(request.threshold).toBe(500)
	})
})

describe("signalToQueryParams", () => {
	it("parses traces query filters from the where clause for alert previews", () => {
		const form = {
			...defaultRuleForm(),
			signalType: "builder_query" as const,
			queryDataSource: "traces" as const,
			queryAggregation: "count",
			queryWhereClause:
				'service.name = "checkout" AND span.name = "GET /checkout" AND has_error = true',
		}

		expect(signalToQueryParams(form)).toEqual({
			source: "traces",
			metric: "count",
			filters: {
				serviceName: "checkout",
				spanName: "GET /checkout",
				errorsOnly: true,
			},
		})
	})

	it("parses logs query filters from the where clause for alert previews", () => {
		const form = {
			...defaultRuleForm(),
			signalType: "builder_query" as const,
			queryDataSource: "logs" as const,
			queryAggregation: "count",
			queryWhereClause: 'service.name = "checkout" AND severity = "error"',
		}

		expect(signalToQueryParams(form)).toEqual({
			source: "logs",
			metric: "count",
			filters: {
				serviceName: "checkout",
				severity: "error",
			},
		})
	})

	it("parses metrics query service filters from the where clause for alert previews", () => {
		const form = {
			...defaultRuleForm(),
			signalType: "builder_query" as const,
			queryDataSource: "metrics" as const,
			queryAggregation: "avg",
			metricName: "cpu.usage",
			metricType: "gauge" as const,
			queryWhereClause: 'service.name = "worker"',
		}

		expect(signalToQueryParams(form)).toEqual({
			source: "metrics",
			metric: "avg",
			filters: {
				metricName: "cpu.usage",
				metricType: "gauge",
				serviceName: "worker",
			},
		})
	})
})
