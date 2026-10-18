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

/** Held far past any capture, so the screenshot is the loading state. */
const HELD_MS = 60_000
const held = (tag: string) => ({ faults: { delays: { [tag]: HELD_MS } }, settle: "held" as const })
const failing = (tag: string) => ({
	faults: {
		failures: {
			[tag]: {
				status: 500,
				body: {
					_tag: "@maple/http/errors/AlertPersistenceError",
					message: "ui-parity: injected alerts failure",
				},
			},
		},
	},
})
const incident = `/alerts/incidents/${SEEDED.alertIncident}`

const EDIT = `/alerts/create?ruleId=${SEEDED.paymentRule}`
const FROM_TEMPLATE = "/alerts/create?template=slow_p95"
const fillNumber = (name: string, value: string) => (page: Page) =>
	page.getByRole("spinbutton", { name, exact: true }).first().fill(value)
const clickRadio = (name: string | RegExp) => (page: Page) => page.getByRole("radio", { name }).first().click()

/** The rule editor's controls: modes, tiers, menus, collapsibles, and its writes. */
const editorScenarios = [
	alert("editor-template-link", "New rule, from the template deep link", FROM_TEMPLATE),
	alert("editor-skip-templates", "New rule, template picker skipped", "/alerts/create", {
		steps: act(clickButton(/^Skip/)),
	}),
	alert("editor-reopen-templates", "New rule, Templates reopened from the bar", FROM_TEMPLATE, {
		steps: act(clickButton(/^Templates$/)),
	}),
	alert("editor-mode-builder", "Edit, switched to the query builder", EDIT, { steps: act(clickButton("Query builder")) }),
	alert("editor-mode-sql", "New rule, switched to SQL", FROM_TEMPLATE, { steps: act(clickButton("SQL")) }),
	alert("editor-builtin-signal", "Edit, the P99 built-in signal", EDIT, { steps: act(clickRadio(/^P99/)) }),
	alert("editor-builder-group-by", "New rule, query builder Group by add-on", "/alerts/create", {
		steps: act(clickButton(/^Skip/), clickButton(/^Group by$/)),
	}),
	// One viewport: growing it for a full-page capture dismisses Base UI's open select.
	alert("editor-comparator-menu", "Edit, the condition select open", EDIT, {
		fullPage: false,
		steps: act((page) => page.getByRole("combobox", { name: "Alert when the value" }).first().click()),
	}),
	alert("editor-critical-tier", "Edit, a critical tier added", EDIT, {
		steps: act(
			(page) => page.getByRole("radiogroup", { name: "Severity" }).getByText("Warning").click(),
			clickButton("Add critical tier"),
		),
	}),
	alert("editor-threshold-changed", "Edit, the threshold changed (impact and was notes)", EDIT, {
		steps: act(fillNumber("Threshold", "1200")),
	}),
	alert("editor-no-data", "Edit, alert on no data switched on", EDIT, {
		steps: act((page) => page.getByRole("switch", { name: "Alert when there is no data" }).first().click()),
	}),
	alert("editor-add-destination-menu", "New rule, the add destination menu", FROM_TEMPLATE, {
		steps: act(clickButton(/^Add destination/)),
	}),
	alert("editor-message-template", "Edit, the message template opened", EDIT, {
		steps: act(clickButton(/^Message template/)),
	}),
	alert("editor-notes", "Edit, notes opened", EDIT, { steps: act(clickButton("Add notes")) }),
	alert("editor-tag", "Edit, a tag added", EDIT, {
		steps: act(async (page) => {
			const tags = page.getByRole("textbox", { name: "Tags" }).first()
			await tags.fill("payments")
			await tags.press("Enter")
		}),
	}),
	alert("editor-dry-run", "Edit, a dry run", EDIT, {
		steps: act(clickButton("Dry run"), waitForText("Preview updated")),
	}),
	alert("editor-send-test", "Edit, a test notification", EDIT, {
		steps: act(clickButton("Send test"), waitForText("Preview ran and sent a test notification")),
	}),
	alert("editor-create", "New rule from a template, created", FROM_TEMPLATE, {
		steps: act(clickButton("Create rule"), waitForText("Rule created")),
	}),
	alert("editor-save", "Edit, threshold changed and saved", EDIT, {
		steps: act(fillNumber("Threshold", "1200"), clickButton("Save changes"), waitForText("Rule updated")),
	}),
	alert("editor-preview-loading", "Edit, the preview held", EDIT, held("alertRules.preview")),
	alert("editor-preview-error", "Edit, the preview failing", EDIT, failing("alertRules.preview")),
	alert("editor-create-error", "New rule, the create failing", FROM_TEMPLATE, {
		...failing("alertRules.create"),
		steps: act(clickButton("Create rule"), waitForText("Failed to save rule")),
	}),
]

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
		alert("edit", "Edit the payment p95 rule", EDIT),
		...editorScenarios,
		alert("incident", "Open payment p95 incident", incident),
		alert("incident-preview-loading", "Incident, signal preview held", incident, held("alertRules.preview")),
		alert("incident-preview-error", "Incident, signal preview failing", incident, failing("alertRules.preview")),
		alert("incident-deliveries-error", "Incident, delivery history failing", incident, failing("alertDeliveries.list")),
		alert("rule-checks-loading", "Rule, checks held", rule, held("alertRules.checks")),
		alert("rule-checks-error", "Rule, checks failing", rule, failing("alertRules.checks")),
		alert("rule-preview-error", "Rule, signal preview failing", rule, failing("alertRules.preview")),
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
		alert("hub-routing-loading", "Hub, Routing with deliveries held", ROUTING, held("alertDeliveries.list")),
		alert("hub-routing-error", "Hub, Routing with deliveries failing", ROUTING, failing("alertDeliveries.list")),
		alert("hub-destination-toggle", "Hub, disable a destination", ROUTING, {
			steps: act(clickSwitch("Disable destination")),
		}),
		alert("hub-destination-test", "Hub, test a destination", ROUTING, {
			steps: act(clickButton(/^Test$/), waitForText("Test notification sent")),
		}),
		alert("hub-new-destination", "Hub, the add destination dialog", ROUTING, {
			steps: act(clickButton("New destination")),
		}),
		alert("hub-new-destination-webhook", "Hub, add a webhook destination", ROUTING, {
			steps: act(
				clickButton("New destination"),
				clickButton(/^Webhook/),
				(page) => page.getByRole("textbox", { name: "Webhook URL", exact: true }).fill("https://hooks.acme.test/new"),
				clickButton("Add Webhook destination"),
				waitForText("Destination created"),
			),
		}),
		alert("hub-edit-destination", "Hub, edit a destination", ROUTING, {
			steps: act(clickButton("Actions for On-call webhook"), clickMenuItem("Edit")),
		}),
		alert("hub-edit-destination-save", "Hub, save an edited destination", ROUTING, {
			steps: act(
				clickButton("Actions for On-call webhook"),
				clickMenuItem("Edit"),
				clickSwitch("Enabled"),
				clickButton("Save changes"),
				waitForText("Destination updated"),
			),
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
