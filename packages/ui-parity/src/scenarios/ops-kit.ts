import type { Locator, Page } from "playwright"
import type { Scenario } from "./types.ts"

/**
 * Shared by the operations areas (alerts, dashboards, anomalies, releases, investigations,
 * recommendations, analytics, replays, share, metrics, errors, traces, service-map). Dataset
 * names and seeded ids are restated here so the capture side never imports `src/fixtures`.
 */

/** `default` plus seeded dashboards, investigations, anomalies and recommendations (same org). */
export const OPS = "acme-ops"
/** Acme's storefront browser sessions: web analytics and session replays. */
export const WEB = "acme-web"
/** A signed-in org with nothing in it. */
export const EMPTY = "empty"

export const SEEDED = {
	paymentRule: "0199a002-0000-7000-8000-000000000002",
	alertIncident: "0199a003-0000-7000-8000-000000000001",
	latencyAnomaly: "0199a060-0000-7000-8000-000000000001",
	diagnosedInvestigation: "0199a061-0000-7000-8000-000000000001",
	runningInvestigation: "0199a061-0000-7000-8000-000000000002",
	doubleEmissionRecommendation: "0199a062-0000-7000-8000-000000000001",
	renameRecommendation: "0199a062-0000-7000-8000-000000000003",
	platformDashboard: "dash_parity_ops_platform",
	paymentDashboard: "dash_parity_ops_payment",
	platformShareToken: "parity_share_platform",
	/** payment-svc 3.5.0, the rollout behind the pool-exhaustion incident. */
	paymentRelease: "f8f3f66ef8f3f66ef8f3f66ef8f3f66ef8f3f66e",
	checkoutReplay: "a11ce5e55100c0ffee00000000000001",
	poolTimeoutTrace: "6843a8853182b32339b2dd5120d423f2",
	triageIssue: "0199a004-0000-7000-8000-000000000001",
} as const

export interface OpsOptions {
	readonly dataset?: string
	readonly steps?: (page: Page) => Promise<void>
	readonly fullPage?: boolean
	readonly mask?: (page: Page) => ReadonlyArray<Locator>
}

/** Desktop, light and dark, on `acme-ops` unless the scenario says otherwise. */
export const opsScenarios =
	(area: string, label: string) =>
	(id: string, title: string, path: string, options: OpsOptions = {}): Scenario => ({
		id: `${area}-${id}`,
		title: `${label}: ${title}`,
		path,
		dataset: options.dataset ?? OPS,
		viewports: ["desktop"],
		themes: ["light", "dark"],
		area,
		...(options.steps === undefined ? undefined : { steps: options.steps }),
		...(options.fullPage === undefined ? undefined : { fullPage: options.fullPage }),
		...(options.mask === undefined ? undefined : { mask: options.mask }),
	})

export const clickButton = (name: string | RegExp) => (page: Page) =>
	page.getByRole("button", { name }).first().click()
export const clickTab = (name: string | RegExp) => (page: Page) => page.getByRole("tab", { name }).click()
export const clickLink = (name: string | RegExp) => (page: Page) =>
	page.getByRole("link", { name }).first().click()
export const checkBox = (name: string | RegExp) => (page: Page) =>
	page.getByRole("checkbox", { name }).first().click()

/** Parks the pointer in a corner so no hover state leaks into the screenshot. */
export const settlePointer = (page: Page) => page.mouse.move(2, 2)

export const act =
	(...steps: ReadonlyArray<(page: Page) => Promise<void>>) =>
	async (page: Page) => {
		for (const step of steps) await step(page)
		await settlePointer(page)
	}
