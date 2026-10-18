import type { Page } from "playwright"
import type { AreaModule, Scenario } from "./types.ts"

/**
 * The app shell in Clerk mode around `/`: the Clerk org switcher (org list, create org, namespace
 * submenu), the Clerk user menu, the billing banners and the onboarding checklist. The page inside
 * is hidden like the self-hosted shell scenarios (`shell.ts`), and its calls are left out.
 */
const hidePage = async (page: Page) => {
	await page
		.getByRole("main")
		.getByRole("main")
		.evaluate((element) => {
			if (element instanceof HTMLElement) element.style.visibility = "hidden"
		})
}

/** What legacy's Overview page sends on an org without telemetry. */
const OVERVIEW_PAGE_CALLS = [
	"anomalies.serviceCounts",
	"queryEngine.serviceHealthSnapshot",
	"queryEngine.serviceUsage",
	"shape:alert_incidents",
	"shape:alert_rule_states",
	"shape:alert_rules",
	"warehouse:",
	// The empty org's on-ramp (ingest key, service overview, signal presence).
	"ingestKeys.retrieve",
	"queryEngine.serviceOverview",
	"telemetrySignals.retrieve",
]

const shell = (
	id: string,
	title: string,
	dataset: string,
	act?: (page: Page) => Promise<void>,
): Scenario => ({
	id: `shell-clerk-${id}`,
	title: `Shell (Clerk): ${title}`,
	path: "/",
	dataset,
	viewports: ["desktop"],
	fullPage: false,
	themes: ["light", "dark"],
	steps: async (page) => {
		await hidePage(page)
		await act?.(page)
	},
	pageCalls: OVERVIEW_PAGE_CALLS,
	area: "shell-clerk",
})

/** The reward pill: a countdown, or "Claim $30 credits" once every step is done. */
const openChecklist = (page: Page) =>
	page
		.getByRole("button", { name: /\d\/4/ })
		.first()
		.click()

const openOrgSwitcher = (page: Page) => page.getByRole("button", { name: /Acme Shop/ }).click()

const openSupportChannel = async (page: Page) => {
	await page.getByRole("button", { name: "Support" }).click()
	await page.getByRole("menuitem", { name: "Shared Slack channel" }).click()
	await page.getByRole("dialog").getByText("Create channel").waitFor()
}

export const shellClerkArea: AreaModule = {
	area: "shell-clerk",
	scenarios: [
		shell("home", "Overview", "clerk-acme"),
		shell("org-switcher", "Org switcher open", "clerk-acme", openOrgSwitcher),
		shell("namespace-submenu", "Namespace submenu open", "clerk-acme", async (page) => {
			await openOrgSwitcher(page)
			await page.getByRole("menuitem", { name: /Namespace/ }).hover()
		}),
		shell("create-org", "Create organization dialog", "clerk-acme", async (page) => {
			await openOrgSwitcher(page)
			await page.getByRole("menuitem", { name: "Create Organization" }).click()
		}),
		shell("create-org-submit", "Create organization: submitted, reloading onto it", "clerk-acme", async (page) => {
			await openOrgSwitcher(page)
			await page.getByRole("menuitem", { name: "Create Organization" }).click()
			await page.getByPlaceholder("Organization name").fill("Orbit Labs")
			// Clerk's `setActive` then a reload: the page comes back on the (stubbed) active org.
			await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Create" }).click()])
			await page.getByRole("button", { name: /Acme Shop/ }).waitFor()
			await hidePage(page)
		}),
		shell("user-menu", "User menu open", "clerk-acme", (page) =>
			page.getByRole("button", { name: /Ada Lovelace/ }).click(),
		),
		shell("support-menu", "Support menu open", "clerk-acme", (page) =>
			page.getByRole("button", { name: "Support" }).click(),
		),
		shell("support-channel", "Shared Slack channel dialog", "clerk-acme", openSupportChannel),
		shell("support-channel-invited", "Shared Slack channel, invite sent", "clerk-acme", async (page) => {
			await openSupportChannel(page)
			await page.getByRole("dialog").getByRole("button", { name: "Create channel" }).click()
			await page.getByText("Invite sent to").waitFor()
		}),
		shell("lapsed", "Subscription ended banner", "clerk-lapsed"),
		shell("flags", "Rollout flags from org metadata", "clerk-flags"),
		shell("past-due", "Payment failed banner", "clerk-past-due"),
		shell("past-due-portal", "Payment failed: opening the billing portal", "clerk-past-due", async (page) => {
			await page.route("https://billing.stripe.com/**", (route) => route.fulfill({ status: 204 }))
			// The reward pointer sits over the banner's action until it is closed.
			await page.getByRole("button", { name: "Got it" }).click()
			await page.getByRole("button", { name: "Update payment method" }).click()
		}),
		shell("quota", "Usage approaching banner", "clerk-quota"),
		shell("quota-dismissed", "Usage banner dismissed", "clerk-quota", (page) =>
			page.getByRole("alert").getByRole("button", { name: "Dismiss" }).click(),
		),
		shell("user-menu-log-out", "User menu: log out", "clerk-acme", async (page) => {
			await page.getByRole("button", { name: /Ada Lovelace/ }).click()
			await page.getByRole("menuitem", { name: "Log out" }).click()
		}),
		shell("checklist-pointer-closed", "Onboarding pointer closed", "clerk-acme", (page) =>
			page.getByRole("button", { name: "Got it" }).click(),
		),
		shell("checklist-open", "Onboarding checklist open", "clerk-acme", (page) => openChecklist(page)),
		shell("checklist-claimable", "Onboarding checklist, credit to claim", "clerk-reward", (page) =>
			openChecklist(page),
		),
		shell("checklist-claimed", "Onboarding checklist, credit claimed", "clerk-reward", async (page) => {
			await openChecklist(page)
			await page.getByRole("dialog").getByRole("button", { name: "Claim $30 credits" }).click()
			await page.getByText("$30 in credits added").waitFor()
		}),
	],
}
