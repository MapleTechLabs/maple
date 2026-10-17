import type { Page } from "playwright"
import type { AreaModule, Scenario, ThemeName, ViewportName } from "./types.ts"

/**
 * The signed-in app shell (sidebar, top bar, banners) around `/` on dataset `default`.
 *
 * The page inside differs until each area is ported, so its region is hidden: the inner `main`
 * (`PageLayout.Content`, nested in the sidebar inset's `main`). It is hidden with
 * `visibility: hidden` rather than `mask` because a mask overlay paints over everything in its box,
 * including the org switcher popup and the mobile nav sheet that open on top of the page.
 */
const pageContent = (page: Page) => page.getByRole("main").getByRole("main")

const hidePage = async (page: Page) => {
	await pageContent(page).evaluate((element) => {
		if (element instanceof HTMLElement) element.style.visibility = "hidden"
	})
}

/** What legacy's Overview page sends (service health, usage cards, charts, environment facets). */
const OVERVIEW_PAGE_CALLS = [
	"anomalies.serviceCounts",
	"queryEngine.serviceHealthSnapshot",
	"queryEngine.serviceUsage",
	"shape:alert_incidents",
	"shape:alert_rule_states",
	"shape:alert_rules",
	"warehouse:",
]

/**
 * With the org switcher open the namespace list needs the 24 h services facets, which legacy's
 * page already cached. Only the page's two chart queries are left out, so that call is compared.
 */
const OVERVIEW_CHART_CALLS = [
	...OVERVIEW_PAGE_CALLS.filter((tag) => tag !== "warehouse:"),
	"warehouse:5b565bdc2e321358",
	"warehouse:a34b0820b35b8824",
]

const shell = (
	id: string,
	title: string,
	options: {
		readonly viewports?: ReadonlyArray<ViewportName>
		readonly themes?: ReadonlyArray<ThemeName>
		readonly act?: (page: Page) => Promise<void>
		readonly pageCalls?: ReadonlyArray<string>
	} = {},
): Scenario => ({
	id: `shell-${id}`,
	title: `Shell: ${title}`,
	path: "/",
	dataset: "default",
	viewports: options.viewports ?? ["desktop"],
	// The chrome only: page bodies are hidden placeholders whose heights differ.
	fullPage: false,
	themes: options.themes ?? ["light", "dark"],
	steps: async (page) => {
		await hidePage(page)
		await options.act?.(page)
	},
	pageCalls: options.pageCalls ?? OVERVIEW_PAGE_CALLS,
	area: "shell",
})

const toggleSidebar = (page: Page) => page.getByRole("button", { name: "Toggle sidebar" }).first().click()

export const shellArea: AreaModule = {
	area: "shell",
	scenarios: [
		shell("home", "Overview"),
		shell("collapsed", "Sidebar collapsed", { act: toggleSidebar }),
		shell("user-menu", "User menu open", {
			act: (page) => page.getByRole("button", { name: /Root$/ }).click(),
		}),
		shell("org-switcher", "Org switcher open", {
			act: (page) => page.getByRole("button", { name: /Self Hosted/ }).click(),
			pageCalls: OVERVIEW_CHART_CALLS,
		}),
		shell("mobile-nav", "Mobile nav open", { viewports: ["mobile"], act: toggleSidebar }),
		shell("laptop", "Laptop", { viewports: ["laptop"] }),
	],
}
