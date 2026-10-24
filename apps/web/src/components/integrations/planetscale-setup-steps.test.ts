import { describe, expect, it } from "vitest"

import { Schema } from "effect"
import { ScrapeTargetId } from "@maple/domain/http"
import type { V2PlanetScaleIntegration, V2PlanetScaleScrapeTarget } from "@maple/domain/http/v2"
import {
	derivePlanetScaleSetup,
	metricsHealthState,
	metricsNeverCollected,
	type LiveCheckId,
} from "./planetscale-setup-steps"

const NOW = Date.parse("2026-08-04T12:00:00Z")

/** The v2 wire format is ISO-8601, so fixtures build timestamps the same way. */
const iso = (epochMs: number) => new Date(epochMs).toISOString()

const target = (over: Partial<V2PlanetScaleScrapeTarget> = {}): V2PlanetScaleScrapeTarget => ({
	id: Schema.decodeUnknownSync(ScrapeTargetId)("11111111-1111-4111-8111-111111111111"),
	object: "planetscale_integration.scrape_target",
	enabled: true,
	scrape_interval_seconds: 30,
	include_branches: [],
	exclude_branches: [],
	last_scrape_at: iso(NOW - 10_000),
	last_scrape_error: null,
	...over,
})

const status = (over: Partial<V2PlanetScaleIntegration> = {}): V2PlanetScaleIntegration => ({
	object: "planetscale_integration",
	connected: true,
	pending_org_selection: false,
	organization: "acme",
	connected_by_user_id: null,
	detected_permissions: { readDatabases: true, readMetricsEndpoints: false },
	metrics_auth: "service_token",
	scrape_target: target(),
	webhooks: null,
	last_inventory_at: iso(NOW - 60_000),
	last_inventory_error: null,
	revoked_at: null,
	expires_at: iso(NOW + 3_600_000),
	...over,
})

const stateOf = (s: V2PlanetScaleIntegration, id: LiveCheckId) =>
	derivePlanetScaleSetup(s, NOW).checks.find((check) => check.id === id)?.state

/** A connection on the metrics API poller, the default since service tokens were retired. */
const viaApi = (
	apiMetrics: V2PlanetScaleIntegration["api_metrics"],
	over: Partial<V2PlanetScaleIntegration> = {},
): V2PlanetScaleIntegration =>
	status({
		metrics_auth: "api",
		api_metrics: apiMetrics,
		scrape_target: target({ enabled: false, last_scrape_at: null }),
		...over,
	})

describe("metricsHealthState (service token)", () => {
	it("is unconfigured when the managed target row is missing", () => {
		expect(metricsHealthState(status({ scrape_target: null }), NOW)).toBe("unconfigured")
	})

	it("prefers the scrape error over every other signal", () => {
		expect(
			metricsHealthState(
				status({ scrape_target: target({ last_scrape_error: "401 Unauthorized" }) }),
				NOW,
			),
		).toBe("degraded")
	})

	it("waits before the first scrape lands", () => {
		expect(metricsHealthState(status({ scrape_target: target({ last_scrape_at: null }) }), NOW)).toBe(
			"waiting",
		)
	})

	it("stalls after three missed intervals, not one", () => {
		// 30s interval: 2 intervals of silence is still healthy, 4 is stalled.
		expect(
			metricsHealthState(status({ scrape_target: target({ last_scrape_at: iso(NOW - 60_000) }) }), NOW),
		).toBe("healthy")
		expect(
			metricsHealthState(
				status({ scrape_target: target({ last_scrape_at: iso(NOW - 120_000) }) }),
				NOW,
			),
		).toBe("stalled")
	})
})

describe("metricsHealthState (metrics API)", () => {
	it("waits before the first poll, ignoring the paused scrape target", () => {
		expect(metricsHealthState(viaApi({ last_polled_at: null, last_error: null }), NOW)).toBe("waiting")
		expect(metricsNeverCollected(viaApi({ last_polled_at: null, last_error: null }))).toBe(true)
	})

	it("treats a status without poll state as waiting, not broken", () => {
		expect(metricsHealthState(viaApi(null), NOW)).toBe("waiting")
		expect(metricsHealthState(viaApi(null, { metrics_auth: "missing" }), NOW)).toBe("waiting")
	})

	it("is healthy after a recent poll, even though the target was never scraped", () => {
		const s = viaApi({ last_polled_at: iso(NOW - 6 * 60_000), last_error: null })
		expect(metricsHealthState(s, NOW)).toBe("healthy")
		expect(metricsNeverCollected(s)).toBe(false)
	})

	it("degrades on a poll error", () => {
		expect(
			metricsHealthState(
				viaApi({ last_polled_at: iso(NOW - 60_000), last_error: "403 Forbidden" }),
				NOW,
			),
		).toBe("degraded")
	})

	it("stalls once polls stop for well over the 5 minute cadence", () => {
		expect(
			metricsHealthState(viaApi({ last_polled_at: iso(NOW - 15 * 60_000), last_error: null }), NOW),
		).toBe("healthy")
		expect(
			metricsHealthState(viaApi({ last_polled_at: iso(NOW - 25 * 60_000), last_error: null }), NOW),
		).toBe("stalled")
	})
})

describe("derivePlanetScaleSetup", () => {
	it("is live when access, resources and the first scrape are all settled", () => {
		const setup = derivePlanetScaleSetup(status(), NOW, { databases: 4, branches: 9 })
		expect(setup.live).toBe("healthy")
		expect(setup.awaitingFirstScrape).toBe(false)
		expect(setup.checks.map((c) => c.state)).toEqual(["done", "done", "done"])
		expect(setup.checks[1]!.detail).toBe("4 databases, 9 branches")
	})

	it("works on the first poll of a fresh connection, and the page keeps polling", () => {
		const setup = derivePlanetScaleSetup(viaApi({ last_polled_at: null, last_error: null }), NOW)
		expect(stateOf(viaApi({ last_polled_at: null, last_error: null }), "first-metrics")).toBe("working")
		expect(setup.live).toBe("pending")
		expect(setup.awaitingFirstScrape).toBe(true)
	})

	it("is live once the first poll lands", () => {
		const setup = derivePlanetScaleSetup(
			viaApi({ last_polled_at: iso(NOW - 60_000), last_error: null }),
			NOW,
		)
		expect(setup.live).toBe("healthy")
		expect(setup.awaitingFirstScrape).toBe(false)
	})

	it("fails on a failed poll, says why, and stops polling status", () => {
		const s = viaApi({ last_polled_at: null, last_error: "rate limited" })
		const setup = derivePlanetScaleSetup(s, NOW)
		expect(stateOf(s, "first-metrics")).toBe("failed")
		expect(setup.checks[2]!.detail).toBe("The last poll failed: rate limited")
		expect(setup.live).toBe("attention")
		expect(setup.awaitingFirstScrape).toBe(false)
	})

	it("polls while a service token's first scrape hasn't landed", () => {
		const s = status({ scrape_target: target({ last_scrape_at: null }) })
		expect(derivePlanetScaleSetup(s, NOW).awaitingFirstScrape).toBe(true)
		expect(stateOf(s, "first-metrics")).toBe("working")
	})

	it("stops polling once the scrape degrades, waiting forever would be a lie", () => {
		const s = status({ scrape_target: target({ last_scrape_error: "403 Forbidden" }) })
		expect(derivePlanetScaleSetup(s, NOW).awaitingFirstScrape).toBe(false)
		expect(stateOf(s, "first-metrics")).toBe("failed")
	})

	it("fails access on a revoked grant and does not wait for anything underneath it", () => {
		const s = viaApi({ last_polled_at: null, last_error: null }, { revoked_at: iso(NOW - 1000) })
		expect(stateOf(s, "access")).toBe("failed")
		expect(stateOf(s, "resources")).toBe("waiting")
		expect(stateOf(s, "first-metrics")).toBe("waiting")
		expect(derivePlanetScaleSetup(s, NOW).live).toBe("attention")
		expect(derivePlanetScaleSetup(s, NOW).awaitingFirstScrape).toBe(false)
	})

	it("fails access on an explicitly denied read_databases scope", () => {
		const s = status({ detected_permissions: { readDatabases: false } })
		expect(stateOf(s, "access")).toBe("failed")
		expect(derivePlanetScaleSetup(s, NOW).accessBlocked).toBe(true)
	})

	it("treats unknown permissions as not-denied", () => {
		// Null before the org is bound, and an absent key is not a denial.
		expect(stateOf(status({ detected_permissions: null }), "access")).toBe("done")
		expect(stateOf(status({ detected_permissions: {} }), "access")).toBe("done")
	})

	it("works while the inventory is first listed, and fails on its error", () => {
		expect(stateOf(status({ last_inventory_at: null }), "resources")).toBe("working")
		expect(stateOf(status({ last_inventory_error: "502 Bad Gateway" }), "resources")).toBe("failed")
	})

	it("adds a webhooks check only when Maple reports webhooks", () => {
		expect(stateOf(status(), "webhooks")).toBeUndefined()
		const failing = status({
			webhooks: { state: "failing", registered_databases: 1, databases: 2, last_error: "limit" },
		})
		expect(stateOf(failing, "webhooks")).toBe("failed")
		expect(derivePlanetScaleSetup(failing, NOW).live).toBe("healthy")
	})
})
