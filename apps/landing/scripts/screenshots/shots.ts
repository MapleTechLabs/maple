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

export const SHOTS: ReadonlyArray<Shot> = [
	{
		id: "surface-traces-peek",
		route: "/traces",
		// Failed checkouts: payment-svc never owns the root span, so filter on the entry point.
		search: { spanNames: ["POST /api/checkout"], hasError: true },
		range: lastMinutes(90),
		setup: async (page) => {
			await page.locator("tr[data-index]").first().click()
			await page.waitForURL(/[?&]peek=/)
		},
	},
	{ id: "surface-service-map", route: "/service-map", range: lastMinutes(60) },
	{ id: "surface-service-detail", route: "/services/payment-svc", range: lastMinutes(6 * 60) },
	{ id: "surface-errors", route: "/errors" },
]
