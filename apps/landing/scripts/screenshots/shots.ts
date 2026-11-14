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
	/** Minutes after the seed anchor to pin the page clock at, for pages that read "now". */
	readonly fakeNowMinutes?: number
}

/** Dev-account labels swapped for the demo's before every capture. */
export const RELABEL = {
	"test's Organization": "Acme",
	"Redirect test US": "Acme",
	"test test": "Ada Lovelace",
	"premium-landing-page.api.localhost": "api.maple.dev",
	"https://api.localhost": "https://api.maple.dev",
	"david+clerk_test@gmail.com": "ada@acme.dev",
} as const

/** Whole text nodes swapped as-is: avatar initials derived from the dev names. */
export const RELABEL_EXACT = { TO: "A", TT: "AL" } as const

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

/** The failing checkout's own trace, on the waterfall tab. */
const openWaterfall = async (page: Page) => {
	await openTrace(page)
	await page
		.getByRole("tab", { name: /waterfall/i })
		.first()
		.click()
}

/** Open the span the incident is about: the payment call that timed out, with its detail panel. */
const selectFailingCharge = async (page: Page) => {
	await page.getByText("INSERT shop.payments").filter({ visible: true }).last().click()
}

/** The rule editor previews a week; the seed holds one day, so frame the last 12 hours. */
const previewLastHours = async (page: Page) => {
	await page
		.getByRole("button", { name: /Last 7 days/ })
		.first()
		.click()
	await page
		.getByText(/^Last 12 hours$/)
		.filter({ visible: true })
		.first()
		.click()
}

/** Onboarding banners ("First trace received") are not part of the product being shown. */
const dismissBanners = async (page: Page) => {
	const close = page.getByRole("button", { name: /dismiss|close/i })
	if ((await close.count()) > 0) await close.first().click()
}

export const SHOTS: ReadonlyArray<Shot> = [
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

	{ id: "gallery-logs-errors", route: "/logs", search: { severities: ["ERROR"] }, range: lastMinutes(60) },
	// Severity, not a service or text filter: with those set the facet rail reads empty.
	{
		id: "gallery-logs-service",
		route: "/logs",
		search: { severities: ["WARN"] },
		range: lastMinutes(30),
	},

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

	{ id: "surface-errors", route: "/errors" },

	// Homepage plates: hero carousel, signals strip, platform sheet, incident story. The clock is
	// pinned to the seed anchor so the pickers read as presets ("Last 24 hours"), not raw dates.
	{
		id: "hero-dashboard",
		route: "/",
		search: { timePreset: "24h" },
		fakeNowMinutes: 0,
		setup: dismissBanners,
	},
	{
		id: "hero-services",
		route: "/services",
		search: { timePreset: "6h" },
		fakeNowMinutes: 0,
		setup: dismissBanners,
	},
	{
		id: "hero-traces",
		route: "/traces",
		search: FAILED_CHECKOUTS,
		range: lastMinutes(90),
		fakeNowMinutes: 0,
		setup: async (page) => {
			await openWaterfall(page)
			await selectFailingCharge(page)
		},
	},
	{
		id: "strip-trace",
		route: "/traces",
		search: FAILED_CHECKOUTS,
		range: lastMinutes(90),
		fakeNowMinutes: 0,
		setup: openWaterfall,
	},
	{ id: "strip-logs", route: "/logs", search: { timePreset: "1h" }, fakeNowMinutes: 0 },
	{ id: "surface-metrics", route: "/metrics", search: { timePreset: "6h" }, fakeNowMinutes: 0 },
	{
		id: "surface-map",
		route: "/service-map",
		search: { timePreset: "1h", environment: "production" },
		fakeNowMinutes: 0,
	},
	{
		id: "surface-alerts",
		route: "/alerts/create",
		search: { serviceName: "checkout-api", template: "slow_p95" },
		fakeNowMinutes: 0,
		setup: previewLastHours,
	},
	{ id: "surface-mcp", route: "/mcp" },
	{
		id: "flow-01-alert",
		route: "/alerts/create",
		search: { serviceName: "payment-svc", template: "high_error_rate" },
		fakeNowMinutes: 0,
		setup: previewLastHours,
	},
	{
		id: "flow-02-trace",
		route: "/traces",
		search: FAILED_CHECKOUTS,
		range: lastMinutes(90),
		fakeNowMinutes: 0,
		setup: async (page) => {
			await openWaterfall(page)
			await selectFailingCharge(page)
		},
	},
	{
		id: "flow-03-logs",
		route: "/logs",
		search: { timePreset: "1h", severities: ["ERROR"] },
		fakeNowMinutes: 0,
		setup: async (page) => {
			// A row opens the log drawer; its header links to the log's own page.
			await page
				.getByText(/timed out acquiring/)
				.first()
				.click()
			await followLink(page, await page.locator('a[href*="/logs/"]').first().getAttribute("href"))
		},
	},
	{
		id: "gallery-issue-detail",
		route: "/errors",
		setup: async (page) => {
			const row = page.locator('a[href*="/errors/issues/"]', { hasText: "ConnectionTimeout" }).first()
			await followLink(page, await row.getAttribute("href"))
		},
	},

	{
		id: "gallery-alert-create",
		route: "/alerts/create",
		search: { serviceName: "payment-svc", template: "high_error_rate" },
	},

	// GitHub: code review and CI. CI runs come from `scripts/seed-ci-runs.ts`, reviews from
	// `scripts/seed-demo/code-review.ts`; both are relative to now, so no anchored range.
	{ id: "surface-code-review", route: "/code-review" },
	{
		id: "gallery-code-review-pr",
		route: "/code-review/pull-requests",
		// acme/web #482, the seed's featured review.
		search: { review: "139b07be-c8f1-4871-a7dc-a7ffbe9a2be5" },
	},
	{ id: "surface-ci", route: "/code-review/ci" },
	{
		id: "gallery-ci-trace",
		route: "/code-review/ci",
		setup: async (page) => {
			const row = page.locator("tr", { hasText: "Failed" }).filter({ hasText: "View trace" }).first()
			await followLink(
				page,
				await row.locator("a", { hasText: "View trace" }).first().getAttribute("href"),
			)
			await page.getByRole("tab", { name: "Waterfall" }).click()
		},
	},
]
