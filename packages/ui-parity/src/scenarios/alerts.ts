import type { Page } from "playwright"
import { clickButton, clickLink, EMPTY, opsScenarios, SEEDED, act } from "./ops-kit.ts"
import type { AreaModule } from "./types.ts"

/** Alert rules (detail, history, create from a template, edit) and the open incident. */
const alert = opsScenarios("alerts", "Alerts")
const rule = `/alerts/${SEEDED.paymentRule}`

const clickMenuItem = (name: string | RegExp) => (page: Page) =>
	page.getByRole("menuitem", { name }).first().click()
const clickSwitch = (name: string | RegExp) => (page: Page) => page.getByRole("switch", { name }).first().click()
const typeInto = (role: "textbox" | "searchbox", text: string) => (page: Page) =>
	page.getByRole(role).first().fill(text)
/** Waits for a toast so the write's answer is on screen before the capture settles. */
const waitForText = (text: string | RegExp) => (page: Page) =>
	page.getByText(text).first().waitFor({ state: "visible" })

const RULES = "/alerts?tab=rules"
const ROUTING = "/alerts?tab=routing"

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
		// The hub's tabs and every control on them.
		alert("hub-tab-rules", "Hub, Rules tab from the tab strip", "/alerts", { steps: act(clickLink(/^Rules/)) }),
		alert("hub-rules-firing", "Hub, Rules filtered to firing", RULES, { steps: act(clickButton(/^Firing/)) }),
		alert("hub-rules-search", "Hub, Rules searched", RULES, { steps: act(typeInto("textbox", "payment")) }),
		alert("hub-rules-search-empty", "Hub, Rules search with no match", RULES, {
			steps: act(typeInto("textbox", "zzz")),
		}),
		alert("hub-rule-menu", "Hub, a rule's action menu", RULES, {
			steps: act(clickButton("Actions for Payment p95 latency")),
		}),
		alert("hub-rule-disable", "Hub, disable a rule from its menu", RULES, {
			steps: act(clickButton("Actions for Payment p95 latency"), clickMenuItem("Disable rule")),
		}),
		alert("hub-routing", "Hub, Routing tab", ROUTING),
		alert("hub-destination-toggle", "Hub, disable a destination", ROUTING, {
			steps: act(clickSwitch("Disable destination")),
		}),
		alert("hub-destination-test", "Hub, test a destination", ROUTING, {
			steps: act(clickButton(/^Test$/), waitForText("Test notification sent")),
		}),
		alert("hub-destination-delete-confirm", "Hub, delete confirmation", ROUTING, {
			steps: act(clickButton("Actions for On-call webhook"), clickMenuItem("Delete")),
		}),
		alert("hub-destination-delete", "Hub, delete a destination", ROUTING, {
			steps: act(
				clickButton("Actions for On-call webhook"),
				clickMenuItem("Delete"),
				clickButton("Delete destination"),
				waitForText("Destination deleted"),
			),
		}),
	],
}
