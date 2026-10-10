/** Screenshots for the feature thread. Same seeded stack and anchor as `shots.ts`. */
import type { Page } from "playwright"
import type { Shot } from "./shots"

import { RELABEL as BASE_RELABEL } from "./shots"
export { TIMEZONE, VIEWPORT, type Shot } from "./shots"

export const RELABEL = { ...BASE_RELABEL, "Verdict Lab": "Investigation" } as const

/** Runs after load: the error and issue pages read "now", so those shots pin the clock. */
type ThreadShot = Shot & { readonly fakeNowMinutes?: number }

const zoomIn = async (page: Page, times: number) => {
	const button = page.locator(".react-flow__controls-zoomin").first()
	if ((await button.count()) === 0) return
	for (let i = 0; i < times; i++) await button.click()
	await page.waitForTimeout(400)
}

const hide = (page: Page, selectors: ReadonlyArray<string>) =>
	page.evaluate((list) => {
		for (const selector of list) {
			for (const el of document.querySelectorAll<HTMLElement>(selector)) el.style.display = "none"
		}
	}, selectors)

const hideByText = (page: Page, texts: ReadonlyArray<string>) =>
	page.evaluate((list) => {
		for (const el of document.querySelectorAll<HTMLElement>("button, span, p, div")) {
			if (el.children.length === 0 && list.includes(el.textContent?.trim() ?? "")) {
				const target = el.closest("button") ?? el
				target.style.visibility = "hidden"
			}
		}
	}, texts)

const lastMinutes = (minutes: number) => ({ fromMinutes: minutes, toMinutes: 0 })
const FAILED_CHECKOUTS = { spanNames: ["POST /api/checkout"], hasError: true }

const followLink = async (page: Page, href: string | null, drop: ReadonlyArray<string> = []) => {
	if (href === null) throw new Error("no link to follow")
	const url = new URL(href, page.url())
	for (const key of drop) url.searchParams.delete(key)
	url.searchParams.set("quota_preview", "1")
	await page.goto(url.toString())
}

const openTrace = async (page: Page) => {
	const href = await page.locator('a[aria-label^="Open trace"]').first().getAttribute("href")
	await followLink(page, href, ["peek", "peekT"])
}

export const SHOTS: ReadonlyArray<ThreadShot> = [
	{ id: "01-service-map", route: "/service-map", range: lastMinutes(60), setup: (page) => zoomIn(page, 1) },
	{
		id: "02-traces-peek",
		route: "/traces",
		search: FAILED_CHECKOUTS,
		range: lastMinutes(90),
		setup: async (page) => {
			await page.locator("tr[data-index]").first().click()
			await page.waitForURL(/[?&]peek=/)
		},
	},
	{
		id: "03-trace-waterfall",
		route: "/traces",
		search: FAILED_CHECKOUTS,
		range: lastMinutes(90),
		setup: async (page) => {
			await openTrace(page)
			await page.getByRole("tab", { name: /waterfall/i }).first().click()
		},
	},
	{
		id: "04-trace-flow",
		route: "/traces",
		search: FAILED_CHECKOUTS,
		range: lastMinutes(90),
		setup: async (page) => {
			await openTrace(page)
			await page.getByRole("tab", { name: /flow/i }).first().click()
			await page.waitForTimeout(800)
			await zoomIn(page, 3)
		},
	},
	{ id: "05-logs", route: "/logs", search: { severities: ["ERROR"] }, range: lastMinutes(90) },
	{
		id: "06-metric-pool",
		route: "/metrics/db.client.connection.pending_requests",
		range: lastMinutes(6 * 60),
	},
	{ id: "07-service-detail", route: "/services/payment-svc", range: lastMinutes(6 * 60) },
	{ id: "08-errors", route: "/errors", fakeNowMinutes: 180 },
	{
		id: "09-issue-detail",
		route: "/errors",
		fakeNowMinutes: 180,
		setup: async (page) => {
			const row = page.locator('a[href*="/errors/issues/"]', { hasText: "ConnectionTimeout" }).first()
			await followLink(page, await row.getAttribute("href"))
		},
	},
	{
		id: "10-alert-create",
		route: "/alerts/create",
		search: { serviceName: "payment-svc", template: "high_error_rate" },
		fakeNowMinutes: 180,
		// The breach count reads the server's clock, which the pinned page clock can't move.
		setup: (page) => hideByText(page, ["No breaches in this window"]),
	},
	{ id: "11-releases", route: "/releases", range: lastMinutes(24 * 60) },
	{
		id: "12-dashboard-templates",
		route: "/dashboards/templates",
		range: lastMinutes(6 * 60),
		search: { template: "service-health" },
	},
	{
		id: "13-investigation",
		route: "/lab/verdict",
		setup: (page) => hide(page, ["main section > header", "main section ~ section"]),
	},
	{
		id: "14-agent-session",
		route: "/lab/agent-session",
		setup: (page) => hideByText(page, ["Clean", "Capture off"]),
	},
	{ id: "15-mcp", route: "/mcp" },
	{ id: "17-infra", route: "/lab/infra", setup: (page) => hideByText(page, ["/infra overview", "/INFRA OVERVIEW"]) },
	{ id: "18-service-map-3d", route: "/service-map", search: { view: "3d" }, range: lastMinutes(60) },
]
