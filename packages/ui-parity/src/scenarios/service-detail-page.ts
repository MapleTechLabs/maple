import type { Page } from "playwright"
import type { AreaModule, Scenario } from "./types.ts"

/** `/services/$serviceName` states and interactions on dataset `default` (payment-svc). */
const detail = (
	id: string,
	title: string,
	options: Pick<Scenario, "faults" | "settle" | "steps" | "fullPage"> & { readonly path?: string },
): Scenario => ({
	id: `service-detail-${id}`,
	title: `Service detail: ${title}`,
	path: options.path ?? "/services/payment-svc",
	dataset: "default",
	viewports: ["desktop"],
	themes: ["light", "dark"],
	faults: options.faults,
	settle: options.settle,
	steps: options.steps,
	fullPage: options.fullPage,
	area: "service-detail",
})

/** Held far past any capture, so the screenshot is the loading state. */
const HELD_MS = 60_000

const failure = (message: string) => ({
	status: 502,
	body: { _tag: "@maple/http/errors/QueryEngineExecutionError", message },
})

const sections = (page: Page) => page.getByRole("navigation", { name: "Service sections" })

const openTab = async (page: Page, label: string, tab: string) => {
	await sections(page).getByRole("link", { name: label, exact: true }).click()
	await page.waitForURL(new RegExp(`tab=${tab}`))
}

export const serviceDetailPageArea: AreaModule = {
	area: "service-detail",
	scenarios: [
		// Five holds at most: Chromium opens six connections per origin, so a sixth held request
		// would queue every other call behind it. The quiet panels render nothing while held.
		detail("loading", "loading (overview, panels and issues held)", {
			faults: {
				delays: {
					"queryEngine.serviceDetailOverview": HELD_MS,
					"queryEngine.serviceOperations": HELD_MS,
					"queryEngine.serviceUsage": HELD_MS,
					"queryEngine.serviceWorkloads": HELD_MS,
					"errorIssues.list": HELD_MS,
				},
			},
			settle: "held",
		}),
		detail("error", "the overview read failing", {
			faults: { failures: { "queryEngine.serviceDetailOverview": failure("ui-parity: injected overview failure") } },
			settle: "quiet",
		}),
		detail("time-range", "last 24 hours from the time range picker", {
			steps: async (page) => {
				await page.getByRole("button", { name: "Last 12 hours" }).click()
				await page.getByRole("dialog").getByRole("button", { name: "Last 1 day" }).click()
				await page.getByRole("dialog").waitFor({ state: "detached" })
			},
		}),
		// First viewport only: growing the viewport for a full-page capture closes the Select.
		detail("environment-open", "environment switcher open", {
			fullPage: false,
			steps: async (page) => {
				await page.getByRole("combobox", { name: "Environment" }).click()
				await page.getByRole("option", { name: "production" }).waitFor()
			},
		}),
		detail("environment", "scoped to production from the switcher", {
			steps: async (page) => {
				await page.getByRole("combobox", { name: "Environment" }).click()
				await page.getByRole("option", { name: "production" }).click()
				await page.getByRole("combobox", { name: "Environment" }).filter({ hasText: "production" }).waitFor()
			},
		}),
		detail("view-all-operations", "Top operations' View all opens the Operations tab", {
			steps: async (page) => {
				await page.getByText("Top operations", { exact: true }).waitFor()
				await page.getByRole("button", { name: "View all →" }).first().click()
				await page.waitForURL(/tab=operations/)
			},
		}),
		detail("tab-api", "API tab", { steps: (page) => openTab(page, "API", "api") }),
		detail("tab-operations", "Operations tab", { steps: (page) => openTab(page, "Operations", "operations") }),
		detail("tab-dependencies", "Dependencies tab", {
			steps: (page) => openTab(page, "Dependencies", "dependencies"),
		}),
		detail("operations-sort", "Operations sorted by error rate, then flipped ascending", {
			steps: async (page) => {
				await openTab(page, "Operations", "operations")
				await page.getByRole("button", { name: "Errors" }).click()
				await page.getByRole("button", { name: "Errors" }).click()
			},
		}),
		detail("api-sort", "API endpoints sorted by path", {
			steps: async (page) => {
				await openTab(page, "API", "api")
				await page.getByRole("button", { name: "Endpoint" }).click()
			},
		}),
		detail("dependencies-sort", "Dependencies sorted by p95", {
			steps: async (page) => {
				await openTab(page, "Dependencies", "dependencies")
				await page.getByRole("button", { name: "p95" }).click()
			},
		}),
		detail("strip-view-all", "the Talks to strip's chip opens the Dependencies tab", {
			steps: async (page) => {
				await page.getByRole("button", { name: "api.stripe.com", exact: true }).click()
				await page.waitForURL(/tab=dependencies/)
			},
		}),
		// The first viewport only: the hovered chart's tooltip and focus, not a grown page.
		detail("chart-hover", "the throughput chart hovered mid-window", {
			fullPage: false,
			steps: async (page) => {
				await page.getByRole("img", { name: "Throughput" }).first().hover({ position: { x: 300, y: 100 } })
			},
		}),
		detail("reload", "Reload re-requests every Overview read unsnapped", {
			steps: async (page) => {
				await page.getByText("Top operations", { exact: true }).waitFor()
				await page.getByRole("button", { name: "Reload" }).click()
			},
		}),
		detail("top-operation-row", "a Top operations row opens the Operations tab", {
			steps: async (page) => {
				await page.getByRole("button", { name: /^INSERT shop\.payments/ }).click()
				await page.waitForURL(/tab=operations/)
			},
		}),
		detail("tab-api-loading", "API tab loading (endpoints held)", {
			path: "/services/payment-svc?tab=api",
			faults: { delays: { "queryEngine.serviceEndpoints": HELD_MS } },
			settle: "held",
		}),
		detail("tab-operations-error", "Operations tab with the operations read failing", {
			path: "/services/payment-svc?tab=operations",
			faults: { failures: { "queryEngine.serviceOperations": failure("ui-parity: injected operations failure") } },
			settle: "quiet",
		}),
	],
}
