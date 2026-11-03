import { describe, expect, test } from "vitest"
import { findingsOf } from "./quick-start-live"

describe("live findings", () => {
	test("names the slowest service and the one failing most often", () => {
		expect(
			findingsOf([
				{ serviceName: "checkout-api", p95LatencyMs: 840, errorRate: 0.002 },
				{ serviceName: "auth", p95LatencyMs: 120, errorRate: 0.04 },
				{ serviceName: "web", p95LatencyMs: 300, errorRate: 0 },
			]),
		).toEqual({
			serviceCount: 3,
			slowest: { serviceName: "checkout-api", p95LatencyMs: 840 },
			mostErrors: { serviceName: "auth", errorRate: 0.04 },
		})
	})

	test("no errors means no error finding, and no services means no findings at all", () => {
		expect(findingsOf([{ serviceName: "web", p95LatencyMs: 300, errorRate: 0 }]).mostErrors).toBeNull()
		expect(findingsOf([])).toEqual({ serviceCount: 0, slowest: null, mostErrors: null })
	})
})
