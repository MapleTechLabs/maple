import { Array as Arr } from "effect"
import { describe, expect, test } from "vitest"
import { FIXTURE_NOW, makeComponent, makeDays, makeSnapshot } from "@maple/status-page/fixtures"
import { component, incident, incidentId, statusPage } from "./test-pages"
import { nextMaintenance, statusReason, summarizePage } from "./derive"
import { downMonitor, httpMonitor } from "../../kit/uptime/test-monitors"
import { formatDaysUptime } from "../../kit/uptime/derive"
import { NOW } from "../../kit/alert-test-rows"

describe("status page summary", () => {
	test("components read as visitors see them, with only the last 90 days of bars", () => {
		const snapshot = makeSnapshot({
			components: [
				makeComponent(0, {
					name: "API",
					group: "Platform",
					days: makeDays(FIXTURE_NOW, { 364: "down" }, 365),
				}),
				makeComponent(1, { name: "Docs", status: "major_outage", monitored: false, days: [] }),
			],
		})
		const summary = summarizePage({ page: statusPage(), snapshot, incidents: [] })
		expect(summary.overall).toBe("major_outage")
		expect(
			Arr.map(summary.components, ({ name, group, status, monitored }) => ({
				name,
				group,
				status,
				monitored,
			})),
		).toEqual([
			{ name: "API", group: "Platform", status: "operational", monitored: true },
			{ name: "Docs", group: null, status: "major_outage", monitored: false },
		])
		const days = summary.components[0]?.days ?? []
		expect(days).toHaveLength(90)
		// Newest last: today's down day is kept, the oldest 275 days are not.
		expect(days.at(-1)?.downChecks).toBeGreaterThan(0)
		expect(formatDaysUptime(days)).toBe("99.97%")
	})

	test("open incidents include drafts; maintenance and resolved incidents are not among them", () => {
		const summary = summarizePage({
			page: statusPage(),
			snapshot: makeSnapshot(),
			incidents: [
				incident(1, { published: false }),
				incident(2, { status: "resolved", resolved_at: new Date(NOW).toISOString() }),
				incident(3, { kind: "maintenance", status: "scheduled" }),
			],
		})
		expect(Arr.map(summary.openIncidents, (open) => open.id)).toEqual([incidentId(1)])
	})

	test("the maintenance shown is the one in progress, else the soonest scheduled", () => {
		const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString()
		const later = incident(1, {
			kind: "maintenance",
			status: "scheduled",
			scheduled_start: at(48),
			scheduled_end: at(50),
		})
		const sooner = incident(2, {
			kind: "maintenance",
			status: "scheduled",
			scheduled_start: at(2),
			scheduled_end: at(4),
		})
		const running = incident(3, {
			kind: "maintenance",
			status: "in_progress",
			scheduled_start: at(-1),
			scheduled_end: at(1),
		})
		const done = incident(4, {
			kind: "maintenance",
			status: "completed",
			scheduled_start: at(-5),
			scheduled_end: at(-4),
		})
		expect(nextMaintenance([later, sooner, done])?.id).toBe(incidentId(2))
		expect(nextMaintenance([later, sooner, running])?.id).toBe(incidentId(3))
		expect(nextMaintenance([done, incident(5)])).toBeNull()
	})
})

describe("status reason", () => {
	test("an open incident behind a status is named, with what the monitor says", () => {
		const up = httpMonitor()
		const row = component(1, { monitor_id: up.id })
		expect(statusReason(row, [up], [incident(1, { title: "Slow loads", impact: "minor" })])).toBe(
			'Degraded by the open incident "Slow loads". The monitor is up.',
		)
	})

	test("a component that shows what its monitor says has no reason, nor does a draft incident", () => {
		const down = downMonitor()
		expect(statusReason(component(1, { monitor_id: down.id }), [down], [])).toBeNull()
		expect(statusReason(component(1), [], [incident(1, { published: false })])).toBeNull()
	})

	test("an override is the reason when no incident is", () => {
		expect(statusReason(component(1, { manual_status: "maintenance" }), [], [])).toBe(
			"Maintenance, set under Override status.",
		)
	})
})
