import type { Page } from "playwright"
import type { AreaModule, Scenario } from "./types.ts"

/** `/` (Overview) states and interactions on dataset `default`. */
const overview = (
	id: string,
	title: string,
	options: Pick<Scenario, "faults" | "settle" | "steps" | "fullPage">,
): Scenario => ({
	id: `overview-${id}`,
	title: `Overview: ${title}`,
	path: "/",
	dataset: "default",
	viewports: ["desktop"],
	themes: ["light", "dark"],
	...options,
	area: "overview",
})

/** Clerk mode with no telemetry yet: `SetupChecklist`'s "Connect your app" card heads the page. */
const clerkSetup = (id: string, title: string, steps?: Scenario["steps"]): Scenario => ({
	...overview(id, title, { steps }),
	dataset: "settings-clerk",
})

/** Held far past any capture, so the screenshot is the loading state. */
const HELD_MS = 60_000

const pickPreset = async (page: Page, label: string) => {
	await page.getByRole("button", { name: "Last 24 hours" }).click()
	await page.getByRole("dialog").getByRole("button", { name: label }).click()
	await page.getByRole("dialog").waitFor({ state: "detached" })
}

export const overviewPageArea: AreaModule = {
	area: "overview",
	scenarios: [
		overview("loading", "loading (execute-batch held)", {
			faults: { delays: { "queryEngine.executeBatch": HELD_MS } },
			settle: "held",
		}),
		overview("error", "execute-batch failing", {
			faults: {
				failures: {
					"queryEngine.executeBatch": {
						status: 502,
						body: {
							_tag: "@maple/http/errors/QueryEngineExecutionError",
							message: "ui-parity: injected execute-batch failure",
						},
					},
				},
			},
			settle: "quiet",
		}),
		// The dataset has one environment, and picking "All environments" falls back to it, so the
		// interaction captured is the open list. First viewport only: growing the viewport for a
		// full-page capture closes Base UI's item-aligned Select.
		overview("environment-open", "environment dropdown open", {
			fullPage: false,
			steps: async (page) => {
				await page.getByRole("combobox").filter({ hasText: "production" }).click()
				await page.getByRole("option", { name: "All environments" }).waitFor()
			},
		}),
		// The hovered chart's tooltip bolds the series nearest the pointer; its siblings draw the
		// linked cursor line at the same time ratio.
		overview("chart-hover", "the latency chart hovered, with the linked cursor", {
			fullPage: false,
			steps: async (page) => {
				const latency = page.getByRole("img", { name: "Latency percentiles" })
				await latency.hover({ position: { x: 260, y: 120 } })
				await latency.hover({ position: { x: 280, y: 186 } })
				await page.waitForTimeout(300)
			},
		}),
		overview("reload", "Reload pressed", {
			steps: async (page) => {
				await page.getByRole("button", { name: "Reload" }).click()
				await page.waitForTimeout(300)
			},
		}),
		overview("view-services", "the rail's View healthy services link followed", {
			steps: async (page) => {
				await page.getByRole("link", { name: "View healthy services" }).click()
				await page.waitForURL(/\/services\?/)
			},
		}),
		overview("service-row", "a service row of the health list followed", {
			steps: async (page) => {
				await page.getByRole("link", { name: /^payment-svc production/ }).click()
				await page.waitForURL(/\/services\/payment-svc/)
			},
		}),
		overview("time-range", "last 6 hours from the time range picker", {
			steps: (page) => pickPreset(page, "Last 6 hours"),
		}),
		clerkSetup("clerk-setup", "Clerk: the setup checklist card"),
		clerkSetup("clerk-setup-collapse", "Clerk: setup checklist collapsed", (page) =>
			page.getByRole("button", { name: "Collapse" }).click(),
		),
		clerkSetup("clerk-setup-framework", "Clerk: setup checklist, Python picked", (page) =>
			page.getByRole("button", { name: "Python" }).click(),
		),
		clerkSetup("clerk-setup-dismiss", "Clerk: setup checklist dismissed", (page) =>
			page.getByRole("button", { name: "Dismiss setup checklist" }).click(),
		),
	],
}
