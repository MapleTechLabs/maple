import { describe, expect, test } from "vitest"
import { collectingLabel, healthReason, projectHealth } from "./health"
import type { SupabaseProjectRow } from "./model"

const row = (overrides: Partial<SupabaseProjectRow> = {}): SupabaseProjectRow => ({
	projectRef: "abcdefghijklmnopqrst",
	cpuAvg: 0.2,
	cpuMax: 0.4,
	memoryAvg: 0.5,
	memoryMax: 0.6,
	memoryTotal: 2e9,
	diskUsedMax: 0.3,
	diskSize: 8e9,
	dbSize: 1e8,
	connectionsAvg: 10,
	connectionsMax: 20,
	maxConnections: 90,
	requests: 1_000,
	requestsPerMinute: 3,
	errors5xx: 5,
	issueCount: 0,
	lastSeen: "2026-10-01 12:00:00",
	...overrides,
})

describe("projectHealth", () => {
	test("a running project inside every limit is healthy", () => {
		expect(projectHealth("ACTIVE_HEALTHY", row(), false)).toEqual({ _tag: "Healthy" })
	})

	test("without a metrics row a running project is unknown, checking only while the read loads", () => {
		expect(projectHealth("ACTIVE_HEALTHY", null, true)).toEqual({ _tag: "Unknown", checking: true })
		expect(projectHealth("ACTIVE_HEALTHY", null, false)).toEqual({ _tag: "Unknown", checking: false })
		expect(healthReason("storefront", { _tag: "Unknown", checking: false })).toBeNull()
	})

	test("degraded at 90% of the connection limit, 5% 5xx, or a 90% CPU, memory or disk peak", () => {
		const reason = (overrides: Partial<SupabaseProjectRow>) =>
			projectHealth("ACTIVE_HEALTHY", row(overrides), false)
		expect(reason({ connectionsMax: 81 })).toEqual({
			_tag: "Degraded",
			reason: "near its connection limit",
		})
		expect(reason({ errors5xx: 50 })).toEqual({
			_tag: "Degraded",
			reason: "5.0% of API requests fail with 5xx",
		})
		expect(reason({ cpuMax: 0.95 })).toEqual({ _tag: "Degraded", reason: "CPU peaked at 95%" })
		expect(reason({ memoryMax: 0.92 })).toEqual({ _tag: "Degraded", reason: "memory peaked at 92%" })
		expect(reason({ diskUsedMax: 0.9 })).toEqual({ _tag: "Degraded", reason: "disk 90% full" })
	})

	test("a handful of failed requests is not a 5xx rate", () => {
		expect(projectHealth("ACTIVE_HEALTHY", row({ requests: 10, errors5xx: 5 }), false)).toEqual({
			_tag: "Healthy",
		})
	})

	test("Supabase's own lifecycle wins over the metrics", () => {
		expect(projectHealth("INACTIVE", row({ cpuMax: 1 }), false)).toEqual({ _tag: "Paused" })
		expect(projectHealth("RESTORE_FAILED", row(), false)).toEqual({
			_tag: "Lifecycle",
			label: "Restore failed",
			tone: "crit",
		})
		expect(projectHealth("COMING_UP", null, true)).toEqual({
			_tag: "Lifecycle",
			label: "Coming up",
			tone: "warn",
		})
	})
})

describe("collectingLabel", () => {
	test("names what is switched on", () => {
		expect(collectingLabel({ metricsEnabled: true, logsEnabled: true })).toBe("Metrics · Logs")
		expect(collectingLabel({ metricsEnabled: false, logsEnabled: true })).toBe("Logs")
		expect(collectingLabel({ metricsEnabled: false, logsEnabled: false })).toBe("Off")
	})
})
