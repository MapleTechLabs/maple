import type { Page } from "playwright"
import type { AreaModule, Scenario } from "./types.ts"

/**
 * Every wired control of the trace pages, one scenario each, so its requests reach the call log
 * and the behavior diff. Dataset `default`, the payment-svc pool-timeout trace.
 */
const TRACE = "6843a8853182b32339b2dd5120d423f2"

const scenario = (
	id: string,
	title: string,
	path: string,
	steps: (page: Page) => Promise<void>,
): Scenario => ({
	id: `traces-${id}`,
	title: `Traces: ${title}`,
	path,
	dataset: "default",
	viewports: ["desktop"],
	themes: ["light", "dark"],
	area: "traces",
	steps: async (page) => {
		await steps(page)
		await page.mouse.move(2, 2)
	},
})

const detail = (id: string, title: string, steps: (page: Page) => Promise<void>) =>
	scenario(`detail-${id}`, title, `/traces/${TRACE}`, steps)
const list = (id: string, title: string, steps: (page: Page) => Promise<void>) =>
	scenario(`list-${id}`, title, "/traces", steps)

const spanOpen = (page: Page) => page.getByText("Span attributes").first().waitFor()
const viewSpan = (page: Page) => page.getByRole("button", { name: "View span" }).click()
const tracesTable = (page: Page) => page.getByRole("table", { name: "Traces" })

export const traceInteractionsArea: AreaModule = {
	area: "traces",
	scenarios: [
		detail("timeline-select-row", "a timeline row clicked opens its span", async (page) => {
			await page.getByText("GET /session", { exact: true }).first().click()
			await spanOpen(page)
		}),
		detail("timeline-alt-collapse", "⌥-click folds a span's whole subtree", async (page) => {
			await page.getByRole("button", { name: "Collapse all" }).click()
			await page
				.getByRole("button", { name: "Expand", exact: true })
				.first()
				.click({ modifiers: ["Alt"] })
			await page.getByText("GET /session", { exact: true }).first().waitFor()
		}),
		detail("copy-trace-id", "the trace ID badge copies", async (page) => {
			await page.getByRole("button", { name: "Copy trace ID" }).first().click()
			await page.getByText("trace ID copied", { exact: true }).waitFor()
		}),
		detail("timeline-collapse-all", "timeline collapsed to the root", async (page) => {
			await page.getByRole("button", { name: "Collapse all" }).click()
		}),
		detail("timeline-expand-level", "timeline collapsed, then one level opened", async (page) => {
			await page.getByRole("button", { name: "Collapse all" }).click()
			await page.getByRole("button", { name: "Expand one level" }).click()
		}),
		detail("timeline-search", "timeline searched for a span", async (page) => {
			await page.getByPlaceholder("Search spans…").fill("session")
		}),
		detail("waterfall-select-row", "a waterfall row clicked opens its span", async (page) => {
			await page.getByRole("tab", { name: "Waterfall" }).click()
			await page.getByText("/session", { exact: true }).first().click()
			await spanOpen(page)
		}),
		detail("waterfall-collapse-all", "waterfall collapsed to the root", async (page) => {
			await page.getByRole("tab", { name: "Waterfall" }).click()
			await page.getByRole("button", { name: "Collapse all" }).click()
		}),
		// The canvas is masked: once the split opens, legacy's React Flow keeps fitting the pre-split
		// pane width (nodes clipped at the right), a library race; the panel and requests still compare.
		{
			...detail("flow-select-node", "a flow node clicked opens its span", async (page) => {
				await page.getByRole("tab", { name: "Flow" }).click()
				await page.getByText("SELECT shop.payments").last().click()
				await spanOpen(page)
			}),
			mask: (page: Page) => [page.locator(".react-flow")],
		},
		detail("flow-back-to-timeline", "flow, then back to the timeline", async (page) => {
			await page.getByRole("tab", { name: "Flow" }).click()
			await page.getByRole("tab", { name: "Timeline" }).click()
		}),
		detail("span-logs-tab", "the span panel's Logs tab", async (page) => {
			await viewSpan(page)
			await page.getByRole("tab", { name: /^Logs/ }).click()
		}),
		detail("span-parent", "the parent span selected from the span panel", async (page) => {
			await viewSpan(page)
			await page.getByTitle("Select the parent span").click()
		}),
		detail("span-close", "the span panel closed", async (page) => {
			await viewSpan(page)
			await page.getByRole("button", { name: /close/i }).first().click()
			await page.getByText("Span attributes").waitFor({ state: "detached" })
		}),
		detail(
			"span-filter-attribute",
			"an attribute's Filter verb opens the filtered list",
			async (page) => {
				await viewSpan(page)
				await page.getByTitle("Filter by db.system = postgresql").click()
				await page.getByRole("button", { name: /Advanced filter/ }).waitFor()
			},
		),
		list("root-only-off", "root traces only unticked (per-span list)", async (page) => {
			await page.getByText("Root traces only", { exact: true }).click()
			await page.getByText("Hide Single-Span Noise").waitFor({ state: "detached" })
			await tracesTable(page).getByRole("row").nth(1).waitFor()
		}),
		list("show-noise", "single-span noise shown", async (page) => {
			await page.getByText("Hide Single-Span Noise", { exact: true }).click()
			await tracesTable(page).getByRole("row").nth(1).waitFor()
		}),
		list("remove-chip", "a facet chosen then its chip removed", async (page) => {
			await page.getByText("production", { exact: true }).first().click()
			await page
				.getByRole("button", { name: /remove/i })
				.first()
				.click()
			await tracesTable(page).getByRole("row").nth(1).waitFor()
		}),
		list("only-option", "a facet's Only verb", async (page) => {
			await page.getByText("production", { exact: true }).first().hover()
			await page.getByRole("button", { name: "Show only production" }).click()
			await tracesTable(page).getByRole("row").nth(1).waitFor()
		}),
		list("reload", "Reload", async (page) => {
			await page.getByRole("button", { name: "Reload" }).click()
			await tracesTable(page).getByRole("row").nth(1).waitFor()
		}),
		list("trace-id-link", "the Trace ID link opens the trace", async (page) => {
			await tracesTable(page).getByRole("link", { name: "0eab694f", exact: true }).click()
			await page.getByRole("tab", { name: "Timeline" }).waitFor()
		}),
	],
}
