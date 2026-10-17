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
