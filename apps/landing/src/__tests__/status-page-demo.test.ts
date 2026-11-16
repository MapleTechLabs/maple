import { describe, expect, it } from "vitest"
import { demoPageHtml, demoStatusJson, MAPLE_DARK } from "../lib/status-page-demo"

describe("status page demo", () => {
	it("renders the operational page without the incident", () => {
		const html = demoPageHtml(MAPLE_DARK, "operational")
		expect(html).toContain("We're fully operational")
		expect(html).not.toContain("Failed payments at checkout")
	})

	it("renders a down monitor as a major outage with the incident open", () => {
		const html = demoPageHtml(MAPLE_DARK, "outage")
		expect(html).toContain("We're experiencing a major outage")
		expect(html).toContain("Failed payments at checkout")
	})

	it("serves the same outage in status.json", () => {
		const json = demoStatusJson()
		expect(json.status.indicator).toBe("critical")
		expect(json.components.find((component) => component.name === "Checkout API")?.status).toBe(
			"major_outage",
		)
		expect(json.incidents.map((incident) => incident.name)).toEqual(["Failed payments at checkout"])
	})
})
