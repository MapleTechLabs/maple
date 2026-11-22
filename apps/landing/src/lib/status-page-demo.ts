/**
 * The status pages feature's demo page, rendered by the real public-page renderer
 * (`@maple/status-page`), so the landing page shows exactly what a published page serves.
 * Used at build time by `LiveStatusPage` and `StatusPageFeeds`, and by
 * `scripts/screenshots/status-pages.ts` for the plates.
 *
 * The story: Checkout API's linked monitor goes down (a down monitor is a major outage)
 * and an incident is open. `operational` is the same page a minute earlier.
 */
import type { StatusPageFreshness, StatusPageThemePreset } from "@maple/domain/status-page"
import { renderBadgeSvg, renderPage, renderStatusJson } from "@maple/status-page"
import { FIXTURE_NOW, makeComponent, makeDays, makeIncident, makeSnapshot } from "@maple/status-page/fixtures"

export type DemoState = "operational" | "outage"

export interface DemoTheme {
	readonly preset: StatusPageThemePreset
	readonly appearance: "light" | "dark"
	readonly font: "sans" | "mono" | "serif"
}

export const MAPLE_DARK: DemoTheme = { preset: "maple", appearance: "dark", font: "sans" }

/** Every preset in the appearance it was drawn for, as the theme picker on the feature page offers them. */
export const DEMO_THEMES = [
	{ label: "Default", theme: { preset: "default", appearance: "light", font: "sans" } },
	{ label: "Paper", theme: { preset: "paper", appearance: "light", font: "serif" } },
	{ label: "Midnight", theme: { preset: "midnight", appearance: "dark", font: "sans" } },
	{ label: "Mono", theme: { preset: "mono", appearance: "dark", font: "mono" } },
	{ label: "Maple", theme: MAPLE_DARK },
] as const satisfies ReadonlyArray<{ label: string; theme: DemoTheme }>

const DAY = 86_400_000
const CHECKOUT_ID = "1c4c9b8e-6f2a-4d1e-9a5b-2f6c8d7e1a01"
const PAGE_URL = "https://status.acme.com"
const FRESH: StatusPageFreshness = { _tag: "live", updatedAt: FIXTURE_NOW - 60_000 }

const MAINTENANCE = makeIncident("2c4c9b8e-6f2a-4d1e-9a5b-2f6c8d7e1a02", {
	kind: "maintenance",
	title: "Database upgrade",
	status: "scheduled",
	startedAt: FIXTURE_NOW + 2 * DAY,
	scheduledStart: FIXTURE_NOW + 2 * DAY,
	scheduledEnd: FIXTURE_NOW + 2 * DAY + 3_600_000,
})

const INCIDENT = makeIncident("2c4c9b8e-6f2a-4d1e-9a5b-2f6c8d7e1a01", {
	title: "Failed payments at checkout",
	impact: "major",
	startedAt: FIXTURE_NOW - 26 * 60_000,
	componentIds: [CHECKOUT_ID],
	updates: [
		{
			id: "3c4c9b8e-6f2a-4d1e-9a5b-2f6c8d7e1a01",
			status: "investigating",
			body: "Some card payments are failing. We're looking into it and will post again within 30 minutes.",
			at: FIXTURE_NOW - 26 * 60_000,
			source: "dashboard",
			overlayEntryId: null,
		},
	],
})

export const demoSnapshot = (theme: DemoTheme, state: DemoState = "outage") => {
	const outage = state === "outage"
	return makeSnapshot({
		page: {
			name: "Acme",
			slug: "acme",
			description: "Status of Acme services",
			websiteUrl: "https://acme.example",
			logoUrl: null,
			theme: {
				preset: theme.preset,
				appearance: theme.appearance,
				accent: null,
				background: null,
				text: null,
				card: null,
				border: null,
				radius: "md",
				font: theme.font,
			},
			showPoweredBy: true,
			privacyUrl: null,
			termsUrl: null,
			customDomain: "status.acme.com",
		},
		components: [
			makeComponent(0, {
				name: "Checkout API",
				group: "API",
				status: outage ? "major_outage" : "operational",
				baseStatus: "operational",
				days: makeDays(
					FIXTURE_NOW,
					outage ? { 23: "down", 61: "degraded", 89: "down" } : { 23: "down", 61: "degraded" },
				),
			}),
			makeComponent(1, { name: "Auth", group: "API", days: makeDays(FIXTURE_NOW, { 47: "degraded" }) }),
			makeComponent(2, {
				name: "Web app",
				group: "Dashboard",
				days: makeDays(FIXTURE_NOW, { 12: "degraded" }),
			}),
			makeComponent(3, { name: "Webhooks", group: "Dashboard", showUptime: false }),
		],
		incidents: outage ? [INCIDENT, MAINTENANCE] : [MAINTENANCE],
	})
}

/** The published page's HTML, as `apps/status` serves it. */
export const demoPageHtml = (theme: DemoTheme, state: DemoState = "outage"): string =>
	renderPage(demoSnapshot(theme, state), FRESH, FIXTURE_NOW)

/** The page's `/api/v1/status.json` body. */
export const demoStatusJson = () => renderStatusJson(demoSnapshot(MAPLE_DARK), FRESH, PAGE_URL)

/** The page's `/badge.svg` in either state. */
export const demoBadgeSvg = (state: DemoState): string =>
	renderBadgeSvg(demoSnapshot(MAPLE_DARK, state), FRESH)
