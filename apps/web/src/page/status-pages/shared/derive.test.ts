import { describe, expect, test } from "vitest"
import { component, componentId, incident, statusPage } from "./test-pages"
import { summarizePage } from "./derive"
import { downMonitor, httpMonitor } from "../../alerts/shared/uptime-test-monitors"

describe("status page summary", () => {
	test("a component whose monitor is down puts the page in a major outage", () => {
		const down = downMonitor()
		const summary = summarizePage({
			page: statusPage(),
			components: [component(1), component(2, { monitor_id: down.id })],
			incidents: [],
			monitors: [httpMonitor(), down],
		})
		expect(summary.overall).toBe("major_outage")
		expect(summary.componentCount).toBe(2)
	})

	test("a draft incident counts as open but does not change what visitors see", () => {
		const summary = summarizePage({
			page: statusPage(),
			components: [component(1)],
			incidents: [incident(1, { published: false, impact: "critical" })],
			monitors: [],
		})
		expect(summary.overall).toBe("operational")
		expect(summary.openIncidents).toBe(1)
	})

	test("a published incident degrades only the components it names, and a resolved one is not open", () => {
		const summary = summarizePage({
			page: statusPage(),
			components: [component(1), component(2)],
			incidents: [
				incident(1, { impact: "minor", component_ids: [componentId(2)] }),
				incident(2, { status: "resolved", impact: "critical" }),
			],
			monitors: [],
		})
		expect(summary.overall).toBe("degraded")
		expect(summary.openIncidents).toBe(1)
	})
})
