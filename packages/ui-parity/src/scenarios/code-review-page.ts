import type { Page } from "playwright"
import type { AreaModule, Scenario } from "./types.ts"

/**
 * Code Review interactions on dataset `code-review`: every filter, select, tab control and write
 * clicked through, plus each tab's loading and error state. The page captures are in `code-review.ts`.
 */
const DATASET = "code-review"

/** Held far past any capture, so the screenshot is the loading state. */
const HELD_MS = 60_000

/** `payments` in the fixture (`repoId(2)`). */
export const PAYMENTS_REPO = "00000c01-0000-4000-8000-000000000002"

type Options = Readonly<{
	steps?: (page: Page) => Promise<void>
	faults?: Scenario["faults"]
	settle?: Scenario["settle"]
}>

export const codeReviewScenario = (id: string, title: string, path: string, options: Options = {}): Scenario => ({
	id: `code-review-${id}`,
	title: `Code review: ${title}`,
	path,
	dataset: DATASET,
	viewports: ["desktop"],
	themes: ["light", "dark"],
	steps: options.steps,
	faults: options.faults,
	settle: options.settle,
	area: "code-review",
})

export const pick = async (page: Page, select: string, option: string) => {
	await page.getByRole("combobox", { name: select }).click()
	await page.getByRole("option", { name: option }).click()
}

export const held = (prefix: string): Options => ({ faults: { delays: { [prefix]: HELD_MS } }, settle: "held" })

export const failing = (prefix: string): Options => ({
	faults: {
		failures: {
			[prefix]: {
				status: 503,
				body: {
					_tag: "@maple/http/pr-review/PrReviewPersistenceError",
					message: "ui-parity: injected code review failure",
				},
			},
		},
	},
	settle: "quiet",
})

const analytics = (id: string, title: string, options: Options) =>
	codeReviewScenario(`analytics-${id}`, `Analytics: ${title}`, "/code-review", options)

export const codeReviewPageArea: AreaModule = {
	area: "code-review",
	scenarios: [
		analytics("loading", "loading (analytics held)", held("codeReview.analytics")),
		analytics("error", "analytics failing", failing("codeReview.analytics")),
		analytics("repository", "filtered to one repository", {
			steps: (page) => pick(page, "Repository", "acme-shop/payments"),
		}),
		analytics("volume-reviews", "volume chart switched to reviews", {
			steps: (page) => pick(page, "Volume metric", "Reviews"),
		}),
		analytics("severity-critical", "issues chart narrowed to critical", {
			steps: (page) => pick(page, "Severity", "Critical"),
		}),
		analytics("time-range", "window switched to a week", {
			steps: async (page) => {
				await page.getByRole("button", { name: "Last 30 days" }).click()
				await page.getByRole("button", { name: "Last 1 week" }).click()
			},
		}),
		codeReviewScenario("analytics-week", "Analytics: deep-linked one-week window", "/code-review?timePreset=1w"),
		analytics("reload", "Reload clicked", {
			steps: (page) => page.getByRole("button", { name: "Reload" }).click(),
		}),
		analytics("clear-filters", "filtered to nothing, then cleared", {
			steps: async (page) => {
				await pick(page, "Author", "grace-h")
				await pick(page, "Repository", "acme-shop/payments")
				await page.getByRole("button", { name: "Clear filters" }).click()
			},
		}),
	],
}
