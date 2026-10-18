import type { Page } from "playwright"
import type { AreaModule, Scenario } from "./types.ts"

/**
 * Pages at the mobile viewport (390 px, below `md` and `lg`): the sidebar is an off-canvas sheet
 * behind the top bar's trigger, and a page's filter rail is a left sheet behind "Open filters".
 */
const mobile = (
	id: string,
	title: string,
	path: string,
	options: Readonly<{ dataset?: string; steps?: (page: Page) => Promise<void> }> = {},
): Scenario => ({
	id: `mobile-${id}`,
	title: `Mobile: ${title}`,
	path,
	dataset: options.dataset ?? "default",
	viewports: ["mobile"],
	themes: ["light", "dark"],
	...(options.steps === undefined ? undefined : { steps: options.steps }),
	area: "mobile",
})

const openFilters = async (page: Page) => {
	await page.getByRole("button", { name: "Open filters" }).click()
	await page.getByRole("dialog", { name: "Filters" }).waitFor()
}

const openNav = async (page: Page) => {
	await page.getByRole("button", { name: "Toggle sidebar" }).first().click()
	await page.getByRole("dialog", { name: "Sidebar" }).waitFor()
}

const openTimePicker = async (page: Page) => {
	await page.getByRole("button", { name: "Last 12 hours" }).click()
	await page.getByRole("dialog").getByRole("button", { name: "Last 1 day" }).waitFor()
}

/** The pages legacy renders responsively, most used first, each with its filter sheet if it has one. */
const pages: ReadonlyArray<Readonly<{ id: string; title: string; path: string; filters: boolean }>> = [
	{ id: "overview", title: "Overview", path: "/", filters: false },
	{ id: "services", title: "Services", path: "/services", filters: true },
	{ id: "traces", title: "Traces", path: "/traces", filters: true },
	{ id: "logs", title: "Logs", path: "/logs", filters: true },
	{ id: "errors", title: "Errors", path: "/errors", filters: true },
	{ id: "dashboards", title: "Dashboards", path: "/dashboards", filters: false },
	{ id: "chat", title: "Chat", path: "/chat", filters: false },
	{ id: "alerts", title: "Alerts", path: "/alerts", filters: false },
	{ id: "service-map", title: "Service map", path: "/service-map", filters: false },
	{ id: "metrics", title: "Metrics", path: "/metrics", filters: false },
	{ id: "settings", title: "Settings", path: "/settings", filters: true },
]

export const mobileArea: AreaModule = {
	area: "mobile",
	scenarios: [
		...pages.flatMap((entry) => [
			mobile(entry.id, entry.title, entry.path),
			...(entry.filters
				? [mobile(`${entry.id}-filters`, `${entry.title}, filter sheet open`, entry.path, { steps: openFilters })]
				: []),
		]),
		mobile("services-empty", "Services (empty org)", "/services", { dataset: "empty" }),
		mobile("services-nav", "Services, sidebar sheet open", "/services", { steps: openNav }),
		mobile("services-time-picker", "Services, time range picker open", "/services", {
			steps: openTimePicker,
		}),
		mobile("services-org-switcher", "Services, org switcher open in the sidebar sheet", "/services", {
			steps: async (page) => {
				await openNav(page)
				await page.getByRole("button", { name: /Self Hosted/ }).click()
				await page.getByRole("menu").waitFor()
			},
		}),
		mobile("chat-switch", "Chat, conversation sheet open", "/chat", {
			steps: async (page) => {
				await page.getByRole("button", { name: "Switch conversation" }).click()
				await page.getByRole("dialog", { name: "Conversations" }).waitFor()
			},
		}),
		mobile("chat-nav", "Chat, sidebar sheet open from the chat header", "/chat", { steps: openNav }),
	],
}
