import { describe, expect, it } from "vitest"
import { StatusPageComponentId, StatusPageId } from "./primitives"
import {
	applyOverlay,
	dayState,
	deriveComponentStatus,
	fillDays,
	lastDays,
	overallStatus,
	overlayIncidentId,
	pageFreshness,
	sha256Base64Url,
	STATUS_PAGE_STALE_AFTER_MS,
	type StatusPageSnapshot,
	uptimePercent,
} from "./status-page"

const API = StatusPageComponentId.make("22222222-2222-4222-8222-222222222222")
const NOW = Date.UTC(2026, 9, 28, 12)

const snapshot = (overrides: Partial<StatusPageSnapshot> = {}): StatusPageSnapshot => ({
	schemaVersion: 1,
	pageId: StatusPageId.make("11111111-1111-4111-8111-111111111111"),
	revision: 3,
	generatedAt: NOW,
	probesSeenAt: NOW,
	page: {
		name: "Acme",
		slug: "acme",
		description: null,
		websiteUrl: null,
		logoUrl: null,
		brandColor: null,
		showPoweredBy: true,
	},
	breakGlassTokenSha256: null,
	components: [
		{
			id: API,
			name: "API",
			description: null,
			group: null,
			status: "operational",
			showUptime: true,
			days: [{ day: "2026-10-28", checks: 10, failures: 0, downChecks: 0 }],
		},
	],
	incidents: [],
	...overrides,
})

describe("deriveComponentStatus", () => {
	it("is a major outage while the monitor is down, whatever the override says", () => {
		expect(
			deriveComponentStatus({ monitorStatus: "down", manualStatus: "degraded", incidentStatuses: [] }),
		).toBe("major_outage")
	})

	it("takes the worst of the override and active incidents when the monitor is up", () => {
		expect(
			deriveComponentStatus({
				monitorStatus: "up",
				manualStatus: "maintenance",
				incidentStatuses: ["degraded"],
			}),
		).toBe("degraded")
		expect(deriveComponentStatus({ monitorStatus: null, manualStatus: null, incidentStatuses: [] })).toBe(
			"operational",
		)
	})
})

describe("bars", () => {
	it("colours a day by its worst moment and reports uptime as the share of checks not down", () => {
		expect(dayState({ day: "2026-10-28", checks: 0, failures: 0, downChecks: 0 })).toBe("none")
		expect(dayState({ day: "2026-10-28", checks: 10, failures: 1, downChecks: 0 })).toBe("degraded")
		expect(dayState({ day: "2026-10-28", checks: 10, failures: 3, downChecks: 2 })).toBe("down")
		expect(
			uptimePercent([
				{ day: "2026-10-27", checks: 100, failures: 0, downChecks: 0 },
				{ day: "2026-10-28", checks: 100, failures: 2, downChecks: 1 },
			]),
		).toBe(99.5)
		expect(uptimePercent([])).toBeNull()
	})

	it("fills a window of days ending today, oldest first, with empty days where nothing ran", () => {
		const days = lastDays(NOW, 3)
		expect(days).toEqual(["2026-10-26", "2026-10-27", "2026-10-28"])
		expect(fillDays(days, [{ day: "2026-10-27", checks: 4, failures: 0, downChecks: 0 }])).toEqual([
			{ day: "2026-10-26", checks: 0, failures: 0, downChecks: 0 },
			{ day: "2026-10-27", checks: 4, failures: 0, downChecks: 0 },
			{ day: "2026-10-28", checks: 0, failures: 0, downChecks: 0 },
		])
	})
})

describe("pageFreshness", () => {
	it("is live while both the publisher and the probes are recent", () => {
		expect(pageFreshness({ snapshot: snapshot(), heartbeatAt: NOW, nowMs: NOW + 60_000 })._tag).toBe(
			"live",
		)
	})

	it("says delayed when the probes stop, even though the publisher still beats", () => {
		const stale = NOW - STATUS_PAGE_STALE_AFTER_MS - 1
		const freshness = pageFreshness({
			snapshot: snapshot({ probesSeenAt: stale }),
			heartbeatAt: NOW,
			nowMs: NOW,
		})
		expect(freshness).toEqual({ _tag: "delayed", updatedAt: stale })
	})

	it("says delayed when the publisher stops, and ignores probes on a page with no monitors", () => {
		const later = NOW + STATUS_PAGE_STALE_AFTER_MS + 1
		expect(pageFreshness({ snapshot: snapshot(), heartbeatAt: null, nowMs: later })._tag).toBe("delayed")
		const manualOnly = snapshot({
			probesSeenAt: null,
			components: snapshot().components.map((component) => ({ ...component, days: [] })),
		})
		expect(pageFreshness({ snapshot: manualOnly, heartbeatAt: NOW, nowMs: NOW + 60_000 })._tag).toBe(
			"live",
		)
	})
})

describe("applyOverlay", () => {
	it("opens an incident from a break-glass entry, follows later entries for it, and marks components", () => {
		const opened = {
			id: "e1",
			at: NOW + 1_000,
			incidentId: null,
			title: "API errors",
			status: "investigating" as const,
			impact: "major" as const,
			body: "We are looking into elevated errors.",
			componentIds: [API],
		}
		const followUp = {
			...opened,
			id: "e2",
			at: NOW + 2_000,
			incidentId: overlayIncidentId("e1"),
			title: null,
			status: "identified" as const,
			body: "A bad deploy; rolling back.",
			componentIds: [],
		}
		// Stored out of order on purpose: entries apply by time.
		const merged = applyOverlay(snapshot(), { entries: [followUp, opened] })
		expect(merged.incidents).toHaveLength(1)
		const incident = merged.incidents[0]
		expect(incident?.title).toBe("API errors")
		expect(incident?.status).toBe("identified")
		expect(incident?.updates.map((update) => update.body)).toEqual([
			"A bad deploy; rolling back.",
			"We are looking into elevated errors.",
		])
		expect(merged.components[0]?.status).toBe("partial_outage")
		expect(overallStatus(merged)).toBe("partial_outage")
	})

	it("stops marking components once the incident is resolved", () => {
		const merged = applyOverlay(snapshot(), {
			entries: [
				{
					id: "e1",
					at: NOW,
					incidentId: null,
					title: "Blip",
					status: "resolved",
					impact: "critical",
					body: "Recovered.",
					componentIds: [API],
				},
			],
		})
		expect(merged.incidents[0]?.resolvedAt).toBe(NOW)
		expect(overallStatus(merged)).toBe("operational")
	})
})

describe("sha256Base64Url", () => {
	it("matches the known digest of a value, without padding", async () => {
		expect(await sha256Base64Url("abc")).toBe("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0")
	})
})
