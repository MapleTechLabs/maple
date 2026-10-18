import type { Page } from "playwright"
import type { AreaModule, Scenario } from "./types.ts"

/** Settings tabs, the standalone /mcp page and the /developer redirect. */

const SELF_HOSTED_TABS = [
	"audit-log",
	"ingestion",
	"data-platform",
	"setup-audit",
	"automation",
	"api-keys",
	"mcp",
	"ai-provider",
] as const

/** Tabs with an empty state, on the `empty` org. */
const EMPTY_TABS = [
	"audit-log",
	"api-keys",
	"setup-audit",
	"data-platform",
	"automation",
	"ai-provider",
] as const

/** Tabs only Clerk workspaces show, on the `settings-clerk` dataset. */
const CLERK = "settings-clerk"
const CLERK_TABS = ["organization", "members", "billing", "notifications"] as const
const ACCOUNT_TABS = [
	"profile",
	"emails",
	"password",
	"two-factor",
	"passkeys",
	"connections",
	"sessions",
] as const

const page = (
	id: string,
	title: string,
	path: string,
	options: { readonly dataset?: string; readonly steps?: (page: Page) => Promise<void> } = {},
): Scenario => ({
	id: `settings-${id}`,
	title,
	path,
	dataset: options.dataset ?? "default",
	viewports: ["desktop"],
	themes: ["light", "dark"],
	steps: options.steps,
	area: "settings",
})

const KEYS = "/settings?tab=keys"
const MCP = "/settings?tab=mcp"

const fillCreateDialog = async (target: Page, name: string) => {
	await target.getByRole("textbox", { name: "Name" }).fill(name)
}

/** Every Keys control and write: create (full and restricted), roll, revoke, ingest roll, filters. */
const keysInteractions: ReadonlyArray<Scenario> = [
	page("keys-create-submit", "Keys: create an API key", KEYS, {
		steps: async (target) => {
			await target.getByRole("button", { name: "Create key" }).click()
			await fillCreateDialog(target, "Deploy bot")
			await target.getByRole("button", { name: "Create", exact: true }).click()
			await target.getByText("API key created").waitFor()
		},
	}),
	page("keys-create-restricted", "Keys: create a read-only key", KEYS, {
		steps: async (target) => {
			await target.getByRole("button", { name: "Create key" }).click()
			await fillCreateDialog(target, "Grafana v2")
			await target.getByRole("button", { name: "Restricted" }).click()
			await target.getByRole("button", { name: "All read" }).click()
			await target.getByRole("button", { name: "Create", exact: true }).click()
			await target.getByText("API key created").waitFor()
		},
	}),
	page("keys-create-menu", "Keys: key type menu", KEYS, {
		steps: (target) => target.getByRole("button", { name: "Choose key type" }).click(),
	}),
	page("keys-create-mcp", "Keys: MCP key from the type menu", KEYS, {
		steps: async (target) => {
			await target.getByRole("button", { name: "Choose key type" }).click()
			await target.getByRole("menuitem", { name: "MCP key" }).click()
		},
	}),
	page("keys-revoke", "Keys: revoke an API key", KEYS, {
		steps: async (target) => {
			await target.getByRole("button", { name: "Actions for CI deploy" }).click()
			await target.getByRole("menuitem", { name: "Revoke key" }).click()
			await target.getByRole("alertdialog").getByRole("button", { name: "Revoke key" }).click()
			await target.getByText("Key revoked").waitFor()
		},
	}),
	page("keys-roll", "Keys: roll an API key", KEYS, {
		steps: async (target) => {
			await target.getByRole("button", { name: "Actions for CI deploy" }).click()
			await target.getByRole("menuitem", { name: "Roll key" }).click()
			await target.getByRole("dialog").getByRole("button", { name: "Roll key" }).click()
			await target.getByText("API key rolled").waitFor()
		},
	}),
	page("keys-ingest-roll", "Keys: roll the public ingest key", KEYS, {
		steps: async (target) => {
			await target.getByRole("button", { name: "Actions for public ingest key" }).click()
			await target.getByRole("menuitem", { name: "Roll key" }).click()
			await target.getByRole("alertdialog").getByRole("button", { name: "Roll key" }).click()
			await target.getByText("Public ingest key rolled", { exact: false }).waitFor()
		},
	}),
	page("keys-filters", "Keys: API type, revoked status", KEYS, {
		steps: async (target) => {
			await target.getByRole("button", { name: "API · 2" }).click()
			await target.getByRole("combobox", { name: "Key status" }).click()
			await target.getByRole("option", { name: "Revoked · 1" }).click()
		},
	}),
	page("keys-search", "Keys: search", KEYS, {
		steps: (target) => target.getByRole("textbox", { name: "Search keys" }).fill("graf"),
	}),
	page("keys-reveal-scopes", "Keys: reveal an ingest key, open scopes", KEYS, {
		steps: async (target) => {
			await target.getByRole("button", { name: "Reveal key" }).first().click()
			await target.getByRole("button", { name: /^Scopes/ }).click()
		},
	}),
]

/** MCP writes and controls: create an MCP key, revoke a connected client, search and fold tools. */
const mcpInteractions: ReadonlyArray<Scenario> = [
	page("mcp-create-key", "MCP: create an MCP key into the snippets", MCP, {
		steps: async (target) => {
			await target.getByRole("button", { name: "Create an MCP key" }).click()
			await fillCreateDialog(target, "Cursor laptop")
			await target.getByRole("button", { name: "Create", exact: true }).click()
			await target.getByText("MCP key created").waitFor()
			await target.getByRole("button", { name: "Done" }).click()
		},
	}),
	page("mcp-revoke", "MCP: revoke a connected client", MCP, {
		dataset: "settings-mcp-clients",
		steps: async (target) => {
			await target.getByRole("button", { name: "Revoke", exact: true }).click()
			await target.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click()
			await target.getByText("Client signed out").waitFor()
		},
	}),
	page("mcp-tools", "MCP: search tools, fold a group", MCP, {
		steps: async (target) => {
			await target.getByRole("button", { name: /^Dashboards/ }).click()
			await target.getByRole("textbox", { name: "Search tools" }).fill("trace")
		},
	}),
]

const INGESTION = "/settings?tab=ingestion"
const RULES = "settings-ingestion-rules"

/** Ingestion: setup steps, mappings (add, edit, toggle, delete) and recommendations (apply, dismiss, reopen). */
const ingestionInteractions: ReadonlyArray<Scenario> = [
	page("ingestion-show-setup", "Ingestion: expand setup, pick Python, Instrument tab", INGESTION, {
		steps: async (target) => {
			await target.getByRole("button", { name: "Show setup" }).click()
			await target.getByRole("button", { name: "Python" }).click()
			await target.getByRole("tab", { name: "Instrument" }).click()
		},
	}),
	page("ingestion-add-mapping", "Ingestion: add mapping dialog", INGESTION, {
		steps: (target) => target.getByRole("button", { name: "Add mapping" }).first().click(),
	}),
	page("ingestion-add-mapping-submit", "Ingestion: create a mapping", INGESTION, {
		steps: async (target) => {
			await target.getByRole("button", { name: "Add mapping" }).first().click()
			const dialog = target.getByRole("dialog")
			await dialog.getByRole("textbox", { name: "Name" }).fill("Status code")
			// Each key's suggestion popup closes before the next field (it hides the rest of the dialog).
			const sourceKey = dialog.getByRole("combobox", { name: "Source key" })
			await sourceKey.fill("http.status_code")
			await sourceKey.press("Escape")
			const targetKey = dialog.getByRole("combobox", { name: "Target span attribute key" })
			await targetKey.fill("http.response.status_code")
			await targetKey.press("Escape")
			await dialog.getByRole("button", { name: "Add mapping" }).click()
			await target.getByText("Attribute mapping created").waitFor()
		},
	}),
	page("ingestion-rules", "Ingestion: mappings and recommendations", INGESTION, { dataset: RULES }),
	page("ingestion-rules-closed", "Ingestion: closed recommendations", INGESTION, {
		dataset: RULES,
		steps: (target) => target.getByRole("button", { name: "Closed · 1" }).click(),
	}),
	page("ingestion-apply", "Ingestion: apply a rename recommendation", INGESTION, {
		dataset: RULES,
		steps: async (target) => {
			await target.getByRole("button", { name: "Apply fix" }).click()
			await target.getByText("Mapping created", { exact: false }).waitFor()
		},
	}),
	page("ingestion-dismiss-reopen", "Ingestion: dismiss, then reopen", INGESTION, {
		dataset: RULES,
		steps: async (target) => {
			await target.getByRole("button", { name: "Dismiss" }).first().click()
			await target.getByRole("button", { name: "Closed · 1" }).click()
			await target.getByRole("button", { name: "Reopen" }).click()
		},
	}),
	page("ingestion-toggle-mapping", "Ingestion: turn a mapping on", INGESTION, {
		dataset: RULES,
		steps: (target) => target.getByRole("switch", { name: "Turn on Team label" }).click(),
	}),
	page("ingestion-edit-mapping", "Ingestion: edit a mapping", INGESTION, {
		dataset: RULES,
		steps: async (target) => {
			await target.getByRole("button", { name: "Actions for HTTP status code" }).click()
			await target.getByRole("menuitem", { name: "Edit mapping" }).click()
			await target.getByRole("dialog").getByRole("textbox", { name: "Name" }).fill("HTTP status")
			await target.getByRole("button", { name: "Save changes" }).click()
			await target.getByText("Attribute mapping updated").waitFor()
		},
	}),
	page("ingestion-delete-mapping", "Ingestion: delete a mapping", INGESTION, {
		dataset: RULES,
		steps: async (target) => {
			await target.getByRole("button", { name: "Actions for HTTP status code" }).click()
			await target.getByRole("menuitem", { name: "Delete mapping" }).click()
			await target.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click()
			await target.getByText("Attribute mapping deleted").waitFor()
		},
	}),
]

const SETUP_HEALTH = "/settings?tab=setup-health"

/** Setup health: re-run the audit, open the passing checks. */
const setupHealthInteractions: ReadonlyArray<Scenario> = [
	page("setup-health-rerun", "Setup health: re-run", SETUP_HEALTH, {
		steps: async (target) => {
			await target.getByRole("button", { name: "Re-run" }).click()
			await target.getByRole("button", { name: "Re-run" }).and(target.locator(":enabled")).waitFor()
		},
	}),
	page("setup-health-passing", "Setup health: passing checks", SETUP_HEALTH, {
		steps: (target) => target.getByRole("button", { name: /^Passing/ }).click(),
	}),
]

const AI = "/settings?tab=ai"

/** AI: the triage switch, the daily ceiling save bar, replace / remove the OpenRouter key. */
const aiInteractions: ReadonlyArray<Scenario> = [
	page("ai-toggle-triage", "AI: turn auto-triage off", AI, {
		steps: async (target) => {
			await target.getByRole("switch", { name: "Investigate new incidents" }).click()
			await target.getByText("Auto-triage turned off").waitFor()
		},
	}),
	page("ai-limits", "AI: edit and save a daily ceiling", AI, {
		steps: async (target) => {
			await target.getByRole("textbox", { name: "Investigations per day" }).fill("80")
			await target.getByRole("button", { name: "Save", exact: true }).click()
			await target.getByText("Auto-triage limits saved").waitFor()
		},
	}),
	page("ai-limits-invalid", "AI: invalid ceiling, advanced limits", AI, {
		steps: async (target) => {
			await target.getByRole("textbox", { name: "Investigations per day" }).fill("0")
			await target.getByRole("button", { name: /^Advanced limits/ }).click()
		},
	}),
	page("ai-replace-key", "AI: replace the OpenRouter key", AI, {
		steps: async (target) => {
			await target.getByRole("button", { name: "Replace" }).click()
			await target.getByLabel("New OpenRouter API key").fill("sk-or-v1-parity9Zq1")
			await target.getByRole("button", { name: "Save key" }).click()
			await target.getByText("OpenRouter key saved").waitFor()
		},
	}),
	page("ai-remove-key", "AI: switch back to Maple managed", AI, {
		steps: async (target) => {
			await target.getByRole("radio", { name: "Maple managed" }).click()
			await target.getByRole("alertdialog").getByRole("button", { name: "Remove key" }).click()
			await target.getByText("Switched to Maple managed").waitFor()
		},
	}),
]

const AUTOMATION = "/settings?tab=automation"

/** Automation: route a severity, set its confidence floor, save; run the simulator. */
const automationInteractions: ReadonlyArray<Scenario> = [
	page("automation-save", "Automation: route medium and save", AUTOMATION, {
		steps: async (target) => {
			// Destination toggles are named by id; the third group is "medium".
			await target.getByRole("button", { name: "0199a001-0000-7000-8000-000000000001" }).nth(2).click()
			await target.getByRole("button", { name: "Save policy" }).click()
			await target.getByText("Escalation policy saved").waitFor()
		},
	}),
	page("automation-dirty", "Automation: unsaved edit blocks the simulator", AUTOMATION, {
		steps: (target) => target.getByRole("switch", { name: "Severity escalation" }).click(),
	}),
	page("automation-evaluate", "Automation: evaluate a manual decision", AUTOMATION, {
		steps: async (target) => {
			await target.getByRole("combobox").filter({ hasText: "AI diagnosis" }).selectOption("manual")
			await target.getByRole("button", { name: "Evaluate policy" }).click()
			await target.getByText("route", { exact: true }).waitFor()
		},
	}),
]

const AUDIT = "/settings?tab=audit-log"

/** Audit log: open an entry, filter by actor type, date range and person, refresh. */
const auditInteractions: ReadonlyArray<Scenario> = [
	page("audit-log-detail", "Audit log: an entry's full record", AUDIT, {
		steps: (target) => target.getByRole("button", { name: "Show details: Updated alert rule" }).first().click(),
	}),
	page("audit-log-actor", "Audit log: API key actors", AUDIT, {
		steps: (target) => target.getByRole("button", { name: "API keys", exact: true }).click(),
	}),
	page("audit-log-range", "Audit log: last 7 days", AUDIT, {
		steps: async (target) => {
			await target.getByRole("button", { name: "Date range: All time" }).click()
			await target.getByRole("button", { name: "Last 7 days" }).click()
		},
	}),
	page("audit-log-person", "Audit log: one API key", AUDIT, {
		steps: async (target) => {
			await target.getByRole("combobox", { name: "Person" }).click()
			await target.getByRole("option", { name: "CI deploy" }).click()
		},
	}),
	page("audit-log-refresh", "Audit log: refresh", AUDIT, {
		steps: (target) => target.getByRole("button", { name: "Refresh audit log" }).click(),
	}),
]

const DATA_PLATFORM = "/settings?tab=data-platform"
const DRIFT = "settings-data-platform-drift"

/** Data platform: save the connection, disconnect, read the diff, apply the schema. */
const dataPlatformInteractions: ReadonlyArray<Scenario> = [
	page("data-platform-save", "Data platform: save and test the connection", DATA_PLATFORM, {
		steps: async (target) => {
			await target.getByRole("textbox", { name: "Database" }).fill("maple_prod")
			await target.getByRole("button", { name: "Save and test" }).click()
			await target.getByText("Connection saved and tested").waitFor()
		},
	}),
	page("data-platform-disconnect", "Data platform: disconnect", DATA_PLATFORM, {
		steps: async (target) => {
			await target.getByRole("button", { name: "Disconnect" }).click()
			await target.getByRole("alertdialog").getByRole("button", { name: "Disconnect" }).click()
			await target.getByText("Disconnected", { exact: true }).waitFor()
		},
	}),
	page("data-platform-up-to-date", "Data platform: refresh the diff, list up-to-date tables", DATA_PLATFORM, {
		steps: async (target) => {
			await target.getByRole("button", { name: "Refresh diff" }).click()
			await target.getByRole("button", { name: /up-to-date tables and views/ }).click()
		},
	}),
	page("data-platform-drift", "Data platform: a cluster with drift", DATA_PLATFORM, { dataset: DRIFT }),
	page("data-platform-apply", "Data platform: review and apply the schema", DATA_PLATFORM, {
		dataset: DRIFT,
		steps: async (target) => {
			await target.getByRole("button", { name: "Review and apply" }).click()
			await target.getByRole("alertdialog").getByRole("button", { name: "Apply schema" }).click()
			await target.getByText("Schema apply started").waitFor()
		},
	}),
]

export const settingsArea: AreaModule = {
	area: "settings",
	scenarios: [
		...SELF_HOSTED_TABS.map((tab) => page(tab, `Settings: ${tab}`, `/settings?tab=${tab}`)),
		page("mcp-page", "MCP page", "/mcp"),
		page("developer", "Developer (redirects to API keys)", "/developer"),
		...EMPTY_TABS.map((tab) =>
			page(`${tab}-empty`, `Settings: ${tab} (empty org)`, `/settings?tab=${tab}`, {
				dataset: "empty",
			}),
		),
		page("api-keys-create", "API keys: create dialog", "/settings?tab=api-keys", {
			steps: (page) => page.getByRole("button", { name: "Create key" }).first().click(),
		}),
		page("nav-switch", "Settings nav: Ingestion to MCP", "/settings?tab=ingestion", {
			steps: (page) => page.getByRole("button", { name: "MCP" }).first().click(),
		}),
		page("mcp-cursor", "MCP: Cursor setup tab", "/settings?tab=mcp", {
			steps: (page) => page.getByRole("tab", { name: "Cursor" }).click(),
		}),
		...keysInteractions,
		...mcpInteractions,
		...ingestionInteractions,
		...setupHealthInteractions,
		...aiInteractions,
		...automationInteractions,
		...auditInteractions,
		...dataPlatformInteractions,
		page("audit-log-denied", "Audit log: denied only", "/settings?tab=audit-log", {
			// The outcome filter precedes the table's "Denied" badges in document order.
			steps: (page) => page.getByText("Denied", { exact: true }).first().click(),
		}),
		page("clerk-members-invite", "Members: invite dialog", "/settings?tab=members", {
			dataset: CLERK,
			steps: (page) => page.getByRole("button", { name: "Invite member" }).click(),
		}),
		...CLERK_TABS.map((tab) =>
			page(`clerk-${tab}`, `Settings (Clerk): ${tab}`, `/settings?tab=${tab}`, { dataset: CLERK }),
		),
		...ACCOUNT_TABS.map((tab) =>
			page(`account-${tab}`, `Account: ${tab}`, `/account?tab=${tab}`, { dataset: CLERK }),
		),
	],
}
