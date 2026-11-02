import { DateTime } from "effect"
import { describe, expect, it } from "vitest"
import {
	alertChecksOf,
	auditActorsOf,
	errorVolumeOf,
	productEventsOf,
	resourceAttributesOf,
	type ServiceUsageRow,
	servicesOf,
} from "./evidence-telemetry"

const DAY_MS = 86_400_000
const AT_MS = Date.UTC(2026, 9, 20, 15, 30)
const daysBefore = (days: number) => DateTime.makeUnsafe(AT_MS - days * DAY_MS)

const serviceRow = (overrides: Partial<ServiceUsageRow> = {}): ServiceUsageRow => ({
	serviceName: "checkout-api",
	recentTraceBytes: 0,
	recentLogBytes: 0,
	recentMetricBytes: 0,
	priorTraceBytes: 0,
	priorLogBytes: 0,
	priorMetricBytes: 0,
	firstHour: daysBefore(59),
	lastHour: daysBefore(0),
	activeDaysRecent: 30,
	activeDaysPrior: 30,
	...overrides,
})

describe("servicesOf", () => {
	it("reports each window's volume in GB and when the service was last seen", () => {
		const services = servicesOf(
			[
				serviceRow({
					recentTraceBytes: 12_345_678_901,
					recentLogBytes: 2_000_000,
					priorMetricBytes: 400_000_000,
					lastHour: daysBefore(12),
					activeDaysRecent: 18,
				}),
			],
			{ distinctRecent: 3, distinctPrior: 5 },
			AT_MS,
		)
		expect(services).toEqual({
			distinctRecent: 3,
			distinctPrior: 5,
			top: [
				{
					name: "checkout-api",
					recent: { tracesGB: 12.3, logsGB: 0.002, metricsGB: 0 },
					prior: { tracesGB: 0, logsGB: 0, metricsGB: 0.4 },
					firstSeenDaysBeforeCancel: 59,
					lastSeenDaysBeforeCancel: 12,
					activeDaysRecent: 18,
					activeDaysPrior: 30,
				},
			],
		})
	})

	it("cuts a runaway service name", () => {
		const [service] = servicesOf(
			[serviceRow({ serviceName: "x".repeat(300) })],
			{ distinctRecent: 1, distinctPrior: 1 },
			AT_MS,
		).top
		expect(service!.name).toHaveLength(80)
	})
})

describe("resourceAttributesOf", () => {
	it("gives each value's share of all spans, and the share without the attribute", () => {
		const attributes = resourceAttributesOf(
			[
				{ attributeKey: "deployment.environment.name", attributeValue: "staging", spans: 150 },
				{ attributeKey: "deployment.environment.name", attributeValue: "production", spans: 600 },
				{ attributeKey: "telemetry.sdk.language", attributeValue: "python", spans: 1000 },
			],
			1000,
		)
		const byKey = Object.fromEntries(attributes.map((attribute) => [attribute.key, attribute]))
		expect(byKey["environment"]).toEqual({
			key: "environment",
			notSetShare: 0.25,
			values: [
				{ value: "production", share: 0.6 },
				{ value: "staging", share: 0.15 },
			],
		})
		expect(byKey["telemetry.sdk.language"]!.notSetShare).toBe(0)
		// Never set anywhere: all of it is "not set", not a guessed default.
		expect(byKey["telemetry.sdk.version"]).toEqual({
			key: "telemetry.sdk.version",
			notSetShare: 1,
			values: [],
		})
	})

	it("reads either environment spelling as set, and a service setting both once", () => {
		const environment = (rows: Parameters<typeof resourceAttributesOf>[0]) =>
			resourceAttributesOf(rows, 1000).find((attribute) => attribute.key === "environment")
		// Only the older spelling: still fully set.
		expect(
			environment([{ attributeKey: "deployment.environment", attributeValue: "prod", spans: 1000 }]),
		).toEqual({ key: "environment", notSetShare: 0, values: [{ value: "prod", share: 1 }] })
		// Both spellings on the same spans: not counted twice.
		expect(
			environment([
				{ attributeKey: "deployment.environment", attributeValue: "prod", spans: 800 },
				{ attributeKey: "deployment.environment.name", attributeValue: "prod", spans: 800 },
				{ attributeKey: "deployment.environment.name", attributeValue: "dev", spans: 100 },
			]),
		).toEqual({
			key: "environment",
			notSetShare: 0.1,
			values: [
				{ value: "prod", share: 0.8 },
				{ value: "dev", share: 0.1 },
			],
		})
	})

	it("is empty, not all-unset, when no spans arrived", () => {
		expect(resourceAttributesOf([], 0)).toEqual([])
	})

	it("shows the five most common values only", () => {
		const attributes = resourceAttributesOf(
			Array.from({ length: 8 }, (_, index) => ({
				attributeKey: "telemetry.sdk.version",
				attributeValue: `1.${index}.0`,
				spans: 10 + index,
			})),
			100,
		)
		const versions = attributes.find((attribute) => attribute.key === "telemetry.sdk.version")!
		expect(versions.values.map((value) => value.value)).toEqual([
			"1.7.0",
			"1.6.0",
			"1.5.0",
			"1.4.0",
			"1.3.0",
		])
	})
})

describe("alertChecksOf", () => {
	it("splits skips by reason, groups errors by class and counts distinct rules", () => {
		expect(
			alertChecksOf([
				{ status: "healthy", skipReason: "", errorCategory: "", checks: 900, ruleIds: ["r1", "r2"] },
				{ status: "breached", skipReason: "", errorCategory: "", checks: 12, ruleIds: ["r2"] },
				{ status: "skipped", skipReason: "no_data", errorCategory: "", checks: 300, ruleIds: ["r3"] },
				{ status: "skipped", skipReason: "", errorCategory: "", checks: 4, ruleIds: ["r3"] },
				{
					status: "error",
					skipReason: "",
					errorCategory: "warehouse_unavailable",
					checks: 7,
					ruleIds: ["r1"],
				},
				{ status: "error", skipReason: "", errorCategory: "", checks: 2, ruleIds: ["r1"] },
			]),
		).toEqual({
			checks: 1225,
			healthy: 900,
			breached: 12,
			skipped: { noData: 300, belowMinSamples: 0, noValue: 0, unspecified: 4 },
			errors: [
				{ category: "warehouse_unavailable", checks: 7 },
				{ category: "unknown", checks: 2 },
			],
			rules: 3,
			rulesBreached: 1,
		})
	})

	it("reads an org with no alert rules as zeros", () => {
		expect(alertChecksOf([])).toMatchObject({ checks: 0, rules: 0, errors: [] })
	})
})

describe("errorVolumeOf", () => {
	it("buckets days into weeks counted back from the cancellation", () => {
		const volume = errorVolumeOf(
			[
				{ day: daysBefore(56), errors: 1 },
				{ day: daysBefore(50), errors: 2 },
				{ day: daysBefore(8), errors: 30 },
				{ day: daysBefore(6), errors: 40 },
				{ day: daysBefore(0), errors: 5 },
			],
			{ fingerprintsRecent: 4, fingerprintsPrior: 9 },
			AT_MS,
		)
		expect(volume).toEqual({
			perWeek: [45, 30, 0, 0, 0, 0, 0, 3],
			fingerprintsRecent: 4,
			fingerprintsPrior: 9,
		})
	})
})

describe("productEventsOf", () => {
	it("counts an event recorded both by the server and its trace once, and leaves plan events out", () => {
		expect(
			productEventsOf(
				[
					{ eventName: "integration_connected", recent: 2, prior: 1, lastAt: daysBefore(3) },
					{ eventName: "integration_connected", recent: 2, prior: 1, lastAt: daysBefore(4) },
					{ eventName: "plan_changed", recent: 9, prior: 9, lastAt: daysBefore(1) },
					{ eventName: "dashboard_created", recent: 0, prior: 6, lastAt: daysBefore(41) },
				],
				AT_MS,
			),
		).toEqual([
			{ name: "dashboard_created", recent: 0, prior: 6, lastDaysBeforeCancel: 41 },
			{ name: "integration_connected", recent: 2, prior: 1, lastDaysBeforeCancel: 3 },
		])
	})
})

describe("auditActorsOf", () => {
	it("keeps Maple's own automatic actions apart from the org's people, keys and agents", () => {
		expect(
			auditActorsOf([
				{ actorType: "system", recent: 900, prior: 40 },
				{ actorType: "user", recent: 3, prior: 120 },
				{ actorType: "agent", recent: 0, prior: 15 },
			]),
		).toEqual({
			users: { recent: 3, prior: 120 },
			apiKeys: { recent: 0, prior: 0 },
			agents: { recent: 0, prior: 15 },
			maple: { recent: 900, prior: 40 },
		})
	})
})
