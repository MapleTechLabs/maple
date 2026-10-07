/**
 * Every app screenshot the landing site ships, as data. Captured by
 * `capture.ts` against a local stack seeded with `bun run seed:demo`, with time
 * ranges pinned to the seed's anchor so a re-capture frames the same moment.
 */
import type { Page } from "playwright"

export interface Shot {
	/** Output basename: `public/screenshots/<id>.webp`. */
	readonly id: string
	readonly route: string
	readonly search?: Readonly<Record<string, string | boolean | ReadonlyArray<string>>>
	/** Minutes before the seed anchor the range starts and ends. Omit for pages with a fixed window. */
	readonly range?: { readonly fromMinutes: number; readonly toMinutes: number }
	/** Clicks that reach the framed state once the page has data. */
	readonly setup?: (page: Page) => Promise<void>
}

/** Dev-account labels swapped for the demo's before every capture. */
export const RELABEL = {
	"test's Organization": "Acme",
	"Redirect test US": "Acme",
	"test test": "Ada Lovelace",
} as const

export const VIEWPORT = { width: 1440, height: 810 } as const
export const TIMEZONE = "America/New_York"

const lastMinutes = (minutes: number) => ({ fromMinutes: minutes, toMinutes: 0 })

// Failed checkouts: payment-svc never owns the root span, so filter on the entry point.
const FAILED_CHECKOUTS = { spanNames: ["POST /api/checkout"], hasError: true }

const openPeek = async (page: Page) => {
	await page.locator("tr[data-index]").first().click()
	await page.waitForURL(/[?&]peek=/)
}

/** In-app navigation drops `quota_preview`, so follow a link by URL with the bypass kept. */
const followLink = async (page: Page, href: string | null, drop: ReadonlyArray<string> = []) => {
	if (href === null) throw new Error("no link to follow")
	const url = new URL(href, page.url())
	for (const key of drop) url.searchParams.delete(key)
	url.searchParams.set("quota_preview", "1")
	await page.goto(url.toString())
}

/** The first row's own trace page, by its link: the row overlay is not clickable as a link. */
const openTrace = async (page: Page) => {
	const href = await page.locator('a[aria-label^="Open trace"]').first().getAttribute("href")
	await followLink(page, href, ["peek", "peekT"])
}

export const SHOTS: ReadonlyArray<Shot> = [
	// Distributed tracing
	{ id: "gallery-traces-list", route: "/traces", range: lastMinutes(60) },
	{
		id: "surface-traces-peek",
		route: "/traces",
		search: FAILED_CHECKOUTS,
		range: lastMinutes(90),
		setup: openPeek,
	},
	{
		id: "gallery-trace-waterfall",
		route: "/traces",
		search: FAILED_CHECKOUTS,
		range: lastMinutes(90),
		setup: openTrace,
	},
	{
		id: "gallery-trace-flow",
		route: "/traces",
		search: FAILED_CHECKOUTS,
		range: lastMinutes(90),
		setup: async (page) => {
			await openTrace(page)
			await page.getByRole("tab", { name: /flow/i }).first().click()
		},
	},

	// Logs
	{ id: "gallery-logs-errors", route: "/logs", search: { severities: ["ERROR"] }, range: lastMinutes(60) },
	// Severity, not a service or text filter: with those set the facet rail reads empty.
	{
		id: "gallery-logs-service",
		route: "/logs",
		search: { severities: ["WARN"] },
		range: lastMinutes(30),
	},

	// Metrics and dashboards
	{ id: "gallery-metrics-list", route: "/metrics", range: lastMinutes(60) },
	{
		id: "gallery-metric-latency",
		route: "/metrics/http.server.request.duration",
		range: lastMinutes(6 * 60),
	},
	{
		id: "gallery-metric-pool",
		route: "/metrics/db.client.connection.pending_requests",
		range: lastMinutes(6 * 60),
	},
	{ id: "gallery-dashboard-templates", route: "/dashboards/templates" },

	// Service catalog
	{
		id: "gallery-service-operations",
		route: "/services/payment-svc",
		search: { tab: "operations" },
		range: lastMinutes(60),
	},
	{ id: "surface-service-map", route: "/service-map", range: lastMinutes(60) },
	{ id: "surface-service-detail", route: "/services/payment-svc", range: lastMinutes(6 * 60) },
	{
		id: "gallery-service-dependencies",
		route: "/services/payment-svc",
		search: { tab: "dependencies" },
		range: lastMinutes(60),
	},

	// Errors
	{ id: "surface-errors", route: "/errors" },
	{
		id: "gallery-issue-detail",
		route: "/errors",
		setup: async (page) => {
			const row = page.locator('a[href*="/errors/issues/"]', { hasText: "ConnectionTimeout" }).first()
			await followLink(page, await row.getAttribute("href"))
		},
	},

	// Alerts
	{
		id: "gallery-alert-create",
		route: "/alerts/create",
		search: { serviceName: "payment-svc", template: "high_error_rate" },
		// The preview evaluates after the chart draws; wait for its verdict, not just data.
		setup: async (page) => {
			await page
				.getByText(/would have fired/i)
				.first()
				.waitFor({ timeout: 60_000 })
		},
	},
]
