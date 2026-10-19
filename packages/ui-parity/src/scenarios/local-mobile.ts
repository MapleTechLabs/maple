import type { Page } from "playwright"
import type { AreaModule, Scenario } from "./types.ts"

/**
 * apps/local-ui at the mobile viewport (390 px, below `md`): the sidebar is a sheet behind the
 * header's trigger, and a list page's filter rail is a left drawer behind its Filters button.
 */

const mobile = (id: string, title: string, hash: string, steps?: (page: Page) => Promise<void>): Scenario => ({
	id: `local-mobile-${id}`,
	title: `Local mobile: ${title}`,
	path: `/#${hash}`,
	dataset: "local",
	app: "local",
	viewports: ["mobile"],
	themes: ["light", "dark"],
	area: "local-mobile",
	...(steps === undefined ? undefined : { steps }),
})

const ROUTES: ReadonlyArray<readonly [id: string, title: string, hash: string]> = [
	["traces", "Traces", "/traces"],
	["trace-detail", "Trace detail", "/traces/0eab694ff33721d5a836ce7444afadcc"],
	["logs", "Logs", "/logs"],
	["metrics", "Metrics", "/metrics"],
	["metric-detail", "Metric detail", "/metrics/http.server.request.duration"],
	["services", "Services", "/services"],
	["service-detail", "Service detail", "/services/checkout-api"],
	["service-map", "Service map", "/service-map"],
	["errors", "Errors", "/errors"],
	["sessions", "Sessions", "/sessions"],
	["session-detail", "Session detail", "/sessions/sess-parity-missing"],
	["query", "Query", "/query"],
]

/** The pages drawn in `PageShell`, so they carry the Filters button. */
const FILTERED = new Set(["traces", "logs", "metrics", "services", "errors", "sessions", "query"])

const openFilters = async (page: Page) => {
	await page.getByRole("button", { name: "Filters" }).click()
	await page.getByRole("dialog", { name: "Filters" }).waitFor()
}

const openNav = async (page: Page) => {
	await page.getByRole("button", { name: "Toggle sidebar" }).first().click()
	await page.getByRole("dialog", { name: "Sidebar" }).waitFor()
}

export const localMobileArea: AreaModule = {
	area: "local-mobile",
	scenarios: [
		...ROUTES.map(([id, title, hash]) => mobile(id, title, hash)),
		...ROUTES.filter(([id]) => FILTERED.has(id)).map(([id, title, hash]) =>
			mobile(`${id}-filters`, `${title} filters drawer`, hash, openFilters),
		),
		mobile("nav", "sidebar sheet", "/traces", openNav),
		// A section link closes the sheet on the way out (`setOpenMobile(false)`).
		mobile("nav-navigate", "sidebar link", "/traces", async (page) => {
			await openNav(page)
			await page.getByRole("dialog", { name: "Sidebar" }).getByRole("link", { name: "Logs" }).click()
			await page.getByRole("dialog", { name: "Sidebar" }).waitFor({ state: "detached" })
		}),
		// A facet picked in the drawer keeps it open over the refiltered page.
		mobile("traces-filters-pick", "Traces filter picked in the drawer", "/traces", async (page) => {
			await openFilters(page)
			await page.getByRole("dialog", { name: "Filters" }).getByRole("checkbox", { name: "storefront" }).click()
		}),
		mobile("filters-close", "filters drawer closed", "/traces", async (page) => {
			await openFilters(page)
			await page.getByRole("button", { name: "Close" }).click()
			await page.getByRole("dialog", { name: "Filters" }).waitFor({ state: "detached" })
		}),
	],
}
