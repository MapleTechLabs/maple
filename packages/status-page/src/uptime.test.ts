import { Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { FIXTURE_NOW, fixtureComponentId, makeComponent, makeDays, makeSnapshot } from "./fixtures"
import { renderUptimeJson } from "./uptime"

const PAGE_URL = "https://status.acme.example"

const snapshot = makeSnapshot({
	components: [
		makeComponent(0, {
			name: "API",
			group: "Platform",
			days: makeDays(FIXTURE_NOW, { 0: "none", 363: "degraded", 364: "down" }, 365),
		}),
		makeComponent(1, { name: "Hidden", showUptime: false, days: [] }),
		makeComponent(2, { name: "Manual", monitored: false, days: [] }),
	],
})

describe("renderUptimeJson", () => {
	it("gives each day of the window its uptime and state, newest last, and the window's total", () => {
		const json = renderUptimeJson(snapshot, PAGE_URL, { days: 3, componentId: null })
		expect(json?.page).toMatchObject({ name: "Acme", status_url: PAGE_URL, time_zone: "Etc/UTC" })
		expect(json?.components).toEqual([
			{
				id: fixtureComponentId(0),
				name: "API",
				group: "Platform",
				// 30 of 4320 checks taken while down.
				uptime_percent: 99.3055,
				days: [
					{ date: "2026-10-26", uptime_percent: 100, status: "operational" },
					{ date: "2026-10-27", uptime_percent: 100, status: "degraded" },
					{ date: "2026-10-28", uptime_percent: 97.9166, status: "down" },
				],
			},
		])
	})

	it("leaves out components the page shows no uptime for", () => {
		const json = renderUptimeJson(snapshot, PAGE_URL, { days: 90, componentId: null })
		expect(Arr.map(json?.components ?? [], (component) => component.name)).toEqual(["API"])
		expect(json?.components[0]?.days).toHaveLength(90)
	})

	it("says a day without checks has no data", () => {
		const json = renderUptimeJson(snapshot, PAGE_URL, { days: 365, componentId: null })
		expect(json?.components[0]?.days[0]).toEqual({
			date: "2025-10-29",
			uptime_percent: null,
			status: "no_data",
		})
	})

	it("narrows to one component, and finds none for a hidden or unknown id", () => {
		const one = renderUptimeJson(snapshot, PAGE_URL, { days: 1, componentId: fixtureComponentId(0) })
		expect(Arr.map(one?.components ?? [], (component) => component.name)).toEqual(["API"])
		expect(
			renderUptimeJson(snapshot, PAGE_URL, { days: 1, componentId: fixtureComponentId(1) }),
		).toBeNull()
		expect(renderUptimeJson(snapshot, PAGE_URL, { days: 1, componentId: "nope" })).toBeNull()
	})
})
