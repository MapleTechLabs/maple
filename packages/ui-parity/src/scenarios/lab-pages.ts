import type { Page } from "playwright"
import type { AreaModule, Scenario } from "./types.ts"

/**
 * Interaction states of the fixture lab pages (`/lab/<page>`): the controls each lab offers, driven
 * the same way in both apps. Ids keep the `lab-<page>` prefix so `--filter lab-<page>` includes them.
 */
const variant = (
	id: string,
	title: string,
	path: string,
	steps: (page: Page) => Promise<void>,
): Scenario => ({
	id,
	title,
	path,
	// Signed in like the rest of the lab area: the lab shell boots the app's session checks.
	dataset: "default",
	viewports: ["desktop"],
	themes: ["light", "dark"],
	area: "lab",
	steps,
})

export const labPagesArea: AreaModule = {
	area: "lab",
	scenarios: [
		variant(
			"lab-timeline-select-span",
			"Lab: Trace timeline, a span with events selected",
			"/lab/timeline",
			async (page) => {
				await page.getByText("stage-3 handler").first().click()
				await page.getByText("SearchTimeoutError").first().waitFor()
			},
		),
		variant(
			"lab-timeline-waterfall",
			"Lab: Trace timeline, Waterfall tab",
			"/lab/timeline",
			async (page) => {
				await page.getByRole("tab", { name: "Waterfall" }).click()
			},
		),
		variant(
			"lab-infra-host-scope",
			"Lab: Infrastructure, hosts scoped to Saturated",
			"/lab/infra",
			async (page) => {
				await page
					.getByRole("button", { name: /Saturated/ })
					.first()
					.click()
			},
		),
		variant(
			"lab-infra-host-search",
			"Lab: Infrastructure, hosts searched",
			"/lab/infra",
			async (page) => {
				await page.getByRole("textbox", { name: "Search hosts…" }).fill("eu-0")
			},
		),
		variant(
			"lab-infra-host-sort",
			"Lab: Infrastructure, hosts sorted by name",
			"/lab/infra",
			async (page) => {
				await page.getByRole("button", { name: /^Host/ }).first().click()
			},
		),
		variant("lab-errors-loading", "Lab: Errors, loading state", "/lab/errors", async (page) => {
			await page.getByRole("button", { name: "loading", exact: true }).click()
		}),
		variant("lab-errors-failed", "Lab: Errors, failed state", "/lab/errors", async (page) => {
			await page.getByRole("button", { name: "failed", exact: true }).click()
		}),
		variant("lab-errors-empty", "Lab: Errors, empty state", "/lab/errors", async (page) => {
			await page.getByRole("button", { name: "empty", exact: true }).click()
		}),
		variant("lab-errors-narrow", "Lab: Errors, 600px wide", "/lab/errors", async (page) => {
			await page.getByRole("button", { name: "600px", exact: true }).click()
		}),
		variant("lab-errors-closed", "Lab: Errors, Closed view", "/lab/errors", async (page) => {
			await page.getByRole("tab", { name: "Closed" }).click()
		}),
		variant("lab-errors-sort-volume", "Lab: Errors, sorted by volume", "/lab/errors", async (page) => {
			await page.getByRole("combobox").filter({ hasText: "Most recent" }).click()
			await page.getByRole("option", { name: "Most errors" }).click()
		}),
		variant("lab-time-range-open", "Lab: Time range picker, open", "/lab/time-range", async (page) => {
			await page.getByRole("button", { name: /Last 5 minutes/ }).click()
		}),
		variant(
			"lab-time-range-pick",
			"Lab: Time range picker, a preset picked",
			"/lab/time-range",
			async (page) => {
				await page.getByRole("button", { name: /Last 5 minutes/ }).click()
				await page.getByRole("button", { name: "Last 1 hour" }).click()
			},
		),
		variant("lab-gcp-dashboard-tab", "Lab: Google Cloud dashboard, GKE tab", "/lab/gcp-dashboard", async (page) => {
			await page.getByRole("tab", { name: "GKE" }).click()
		}),
		variant(
			"lab-gcp-dashboard-project",
			"Lab: Google Cloud dashboard, one project picked",
			"/lab/gcp-dashboard",
			async (page) => {
				await page.getByRole("combobox", { name: "Project" }).click()
				await page.getByRole("option", { name: "acme-staging" }).first().click()
			},
		),
		variant(
			"lab-gcp-dashboard-variables",
			"Lab: Google Cloud dashboard, variables dialog",
			"/lab/gcp-dashboard",
			async (page) => {
				await page.getByRole("button", { name: "Manage dashboard variables" }).click()
			},
		),
		variant("lab-service-map-3d-inspect", "Lab: Service map 3D, a node inspected", "/lab/service-map-3d", async (page) => {
			await page.getByRole("button", { name: "Inspect checkout-api", exact: true }).click()
		}),
		variant("lab-service-map-3d-search", "Lab: Service map 3D, inventory filtered", "/lab/service-map-3d", async (page) => {
			await page.getByRole("textbox", { name: "Find a service" }).fill("api")
		}),
	],
}
