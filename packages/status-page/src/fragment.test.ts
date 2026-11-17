import { describe, expect, it } from "vitest"
import { FIXTURE_NOW, fixtureComponentId, makeComponent, makeSnapshot } from "./fixtures"
import { renderFragment } from "./index"

describe("renderFragment", () => {
	const snapshot = makeSnapshot({
		components: [
			makeComponent(0, { name: "API", group: "Platform", status: "major_outage" }),
			makeComponent(1, { name: "Dashboard", group: "Platform" }),
			makeComponent(2, { name: "Docs", showUptime: false, monitored: false, days: [] }),
		],
	})

	it("narrowed to one component, shows it under its group's head and leaves the others and the rest of the page out", () => {
		const html = renderFragment(snapshot, {
			parts: ["components"],
			nowMs: FIXTURE_NOW,
			componentId: fixtureComponentId(1),
		})
		expect(html).toContain("Dashboard")
		expect(html).toContain(`class="group-head"`)
		expect(html).toContain("Platform")
		expect(html).not.toContain(">API<")
		expect(html).not.toContain(">Docs<")
		expect(html).not.toContain("Past incidents")
		expect(html).not.toContain("<footer>")
		expect(html).not.toContain("<script")
	})

	it("is a whole themed document of only the parts asked for, in order", () => {
		const html = renderFragment(snapshot, { parts: ["header", "footer"], nowMs: FIXTURE_NOW })
		expect(html).toMatch(/^<!doctype html>/u)
		expect(html).toContain("--bg:")
		expect(html).toMatch(/<header class="top">[\s\S]*<footer>/u)
		expect(html).toContain("Powered by")
		expect(html).not.toContain("System status")
		expect(html).not.toContain(`class="hero`)
	})

	it("draws the hero from the page's worst component", () => {
		const html = renderFragment(snapshot, { parts: ["hero"], nowMs: FIXTURE_NOW })
		expect(html).toContain("hero s-major_outage")
		expect(html).toContain("API (Major outage)")
		expect(html).not.toContain(`<header class="top">`)
	})
})
