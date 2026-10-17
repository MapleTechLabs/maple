import { clickButton, clickLink, EMPTY, opsScenarios, SEEDED, act } from "./ops-kit.ts"
import type { AreaModule } from "./types.ts"

/** Alert rules (detail, history, create from a template, edit) and the open incident. */
const alert = opsScenarios("alerts", "Alerts")
const rule = `/alerts/${SEEDED.paymentRule}`

export const alertsArea: AreaModule = {
	area: "alerts",
	scenarios: [
		alert("rule", "Payment p95 rule, overview", rule),
		alert("rule-history", "Payment p95 rule, history tab", rule, { steps: act(clickLink("History")) }),
		alert("create", "New rule, template picker", "/alerts/create"),
		alert("create-template", "New rule from the Slow P95 template", "/alerts/create", {
			steps: act(clickButton(/^Slow P95 latency/)),
		}),
		alert("edit", "Edit the payment p95 rule", `/alerts/create?ruleId=${SEEDED.paymentRule}`),
		alert("incident", "Open payment p95 incident", `/alerts/incidents/${SEEDED.alertIncident}`),
		alert("list-empty", "Alerts (empty org)", "/alerts", { dataset: EMPTY }),
	],
}
