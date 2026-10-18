import type { Page } from "playwright"
import type { AreaModule, Scenario } from "./types.ts"

/**
 * Code Review interactions on dataset `code-review`: every filter, select, tab control and write
 * clicked through, plus each tab's loading and error state. The page captures are in `code-review.ts`.
 */
const DATASET = "code-review"

/** Held far past any capture, so the screenshot is the loading state. */
const HELD_MS = 60_000

type Options = Readonly<{
	steps?: (page: Page) => Promise<void>
	faults?: Scenario["faults"]
	settle?: Scenario["settle"]
}>

export const codeReviewScenario = (
	id: string,
	title: string,
	path: string,
	options: Options = {},
): Scenario => ({
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

export const held = (prefix: string): Options => ({
	faults: { delays: { [prefix]: HELD_MS } },
	settle: "held",
})

/** Fails `prefix` and waits for `shown` (the error state, after the GET retries give up). */
export const failing = (prefix: string, shown?: string): Options => ({
	steps:
		shown === undefined
			? undefined
			: (page) => page.getByText(shown).first().waitFor({ timeout: 10_000 }),
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

const pullRequests = (id: string, title: string, options: Options) =>
	codeReviewScenario(
		`pull-requests-${id}`,
		`Pull requests: ${title}`,
		"/code-review/pull-requests",
		options,
	)

const ci = (id: string, title: string, options: Options) =>
	codeReviewScenario(`ci-${id}`, `CI: ${title}`, "/code-review/ci", options)

/** `/lab/code-review-repos`: the repository picker over 246 fixture repositories. */
const reposLab = (id: string, title: string, steps: (page: Page) => Promise<void>): Scenario => ({
	id: `lab-code-review-repos-${id}`,
	title: `Lab: code review repositories, ${title}`,
	path: "/lab/code-review-repos",
	dataset: "default",
	viewports: ["desktop"],
	themes: ["light", "dark"],
	steps,
	area: "code-review",
})

const settings = (id: string, title: string, options: Options) =>
	codeReviewScenario(`settings-${id}`, `Settings: ${title}`, "/code-review/settings", options)

const issues = (id: string, title: string, options: Options) =>
	codeReviewScenario(`issues-${id}`, `Issues: ${title}`, "/code-review/issues", options)

const openReview = (page: Page) =>
	page
		.getByRole("button", { name: /Retry payment capture once/ })
		.first()
		.click()

const reviewSheet = (id: string, title: string, steps: (page: Page) => Promise<void>, extra: Options = {}) =>
	pullRequests(`sheet-${id}`, `review sheet ${title}`, {
		...extra,
		steps: async (page) => {
			await openReview(page)
			await steps(page)
		},
	})

export const codeReviewPageArea: AreaModule = {
	area: "code-review",
	scenarios: [
		analytics("loading", "loading (analytics held)", held("codeReview.analytics")),
		analytics(
			"error",
			"analytics failing",
			failing("codeReview.analytics", "Failed to load review analytics"),
		),
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
		codeReviewScenario(
			"analytics-week",
			"Analytics: deep-linked one-week window",
			"/code-review?timePreset=1w",
		),
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
		pullRequests("loading", "loading (list held)", held("codeReview.listReviews")),
		pullRequests("error", "list failing", failing("codeReview.listReviews", "Failed to load reviews")),
		pullRequests("repository", "filtered to one repository", {
			steps: (page) => pick(page, "Repository", "acme-shop/payments"),
		}),
		pullRequests("author", "filtered to one author", {
			steps: (page) => pick(page, "Author", "ada-l"),
		}),
		pullRequests("clear-filters", "queued only (empty), then cleared", {
			steps: async (page) => {
				await pick(page, "Status", "Queued")
				await page.getByRole("button", { name: "Clear filters" }).click()
			},
		}),
		pullRequests("time-range", "window switched to a week", {
			steps: async (page) => {
				await page.getByRole("button", { name: "Last 30 days" }).click()
				await page.getByRole("button", { name: "Last 1 week" }).click()
			},
		}),
		reviewSheet("close", "opened, then closed", (page) =>
			page.getByRole("button", { name: "Close" }).click(),
		),
		reviewSheet("escape", "opened, then dismissed with Escape", async (page) => {
			await page.getByRole("heading", { name: "Summary" }).waitFor()
			await page.keyboard.press("Escape")
		}),
		reviewSheet("history", "switched to an earlier review of the pull request", (page) =>
			page.getByRole("button", { name: /Skipped/ }).click(),
		),
		reviewSheet("loading", "loading (review held)", async () => {}, {
			faults: { delays: { "codeReview.getReview": HELD_MS } },
			settle: "quiet",
		}),
		reviewSheet(
			"error",
			"review failing",
			async (page) => {
				await page.getByText("Failed to load the review").waitFor({ timeout: 10_000 })
			},
			failing("codeReview.getReview"),
		),
		reviewSheet(
			"ci-error",
			"CI runs failing",
			async (page) => {
				await page.getByText("CI runs could not be loaded").waitFor({ timeout: 10_000 })
			},
			failing("codeReview.ciRuns"),
		),
		ci("loading", "loading (analytics held)", held("codeReview.ciAnalytics")),
		ci("error", "analytics failing", failing("codeReview.ciAnalytics", "Failed to load CI analytics")),
		ci("runs-error", "runs failing", failing("codeReview.ciRuns", "Failed to load CI runs")),
		ci("repository", "filtered to one repository", {
			steps: (page) => pick(page, "Repository", "acme-shop/payments"),
		}),
		ci("workflow", "filtered to one workflow from the select", {
			steps: (page) => pick(page, "Workflow", "E2E"),
		}),
		ci("workflow-row", "a workflow row clicked, then clicked again", {
			steps: async (page) => {
				await page.getByRole("button", { name: /^E2E/ }).click()
				await page
					.getByRole("button", { name: /^E2E/ })
					.and(page.locator("[aria-pressed=true]"))
					.click()
			},
		}),
		ci("branch", "runs narrowed to a branch", {
			steps: (page) => page.getByRole("button", { name: "feat/checkout-retries" }).first().click(),
		}),
		ci("branch-cleared", "a branch filter cleared", {
			steps: async (page) => {
				await page.getByRole("button", { name: "feat/checkout-retries" }).first().click()
				await page.getByRole("button", { name: "Clear branch feat/checkout-retries" }).click()
			},
		}),
		ci("runs-clear-filters", "runs filtered to nothing, then cleared", {
			steps: async (page) => {
				await pick(page, "Result", "Timed out")
				await page.getByRole("button", { name: "Clear filters" }).click()
			},
		}),
		ci("time-range", "window switched to a day", {
			steps: async (page) => {
				await page.getByRole("button", { name: "Last 7 days" }).click()
				await page.getByRole("button", { name: "Last 1 day" }).click()
			},
		}),
		settings("loading", "loading (settings held)", held("integrations.githubGetPrReviewSettings")),
		settings(
			"error",
			"settings failing",
			failing("integrations.githubGetPrReviewSettings", "Failed to load review settings"),
		),
		settings("model", "review model changed (saved)", {
			steps: async (page) => {
				await pick(page, "Review model", "Claude Haiku 5.5")
				await page.getByText("Reviews now run on Claude Haiku 5.5").waitFor()
			},
		}),
		settings("defaults-save", "default rules edited and saved", {
			steps: async (page) => {
				await page
					.getByRole("textbox", { name: "Instructions" })
					.fill("Flag any query without OrgId.")
				await page.getByRole("checkbox", { name: "Tests" }).click()
				await page.getByRole("switch", { name: "Review drafts" }).click()
				await pick(page, "Inline comments", "Every issue")
				await page.getByRole("spinbutton", { name: "Reviews per pull request" }).fill("3")
				await page.getByRole("button", { name: "Save" }).click()
				await page.getByText("Default review rules saved").waitFor()
			},
		}),
		settings("defaults-reset", "default rules edited, then reset", {
			steps: async (page) => {
				await page.getByRole("textbox", { name: "Ignored paths" }).fill("vendor/")
				await page.getByRole("button", { name: "Reset" }).click()
			},
		}),
		settings("defaults-invalid", "default rules with a bad limit", {
			steps: (page) =>
				page.getByRole("spinbutton", { name: "Daily limit per repository" }).fill("9000"),
		}),
		settings("repo-toggle", "reviews turned on for a repository", {
			steps: async (page) => {
				await page.getByRole("switch", { name: "Review pull requests on acme-shop/infra" }).click()
				await page.getByText("Maple will review pull requests on acme-shop/infra").waitFor()
			},
		}),
		settings("repo-rules-save", "a repository's rules edited and saved", {
			steps: async (page) => {
				await page.getByRole("button", { name: "Configure" }).nth(1).click()
				const dialog = page.getByRole("dialog")
				await dialog.getByRole("spinbutton", { name: "Daily limit per repository" }).fill("12")
				await pick(page, "Draft pull requests", "Review drafts")
				await dialog.getByRole("switch", { name: "Use the organization's" }).click()
				await page.getByRole("dialog").getByRole("button", { name: "Save" }).click()
				await page.getByText("Rules saved for acme-shop/shop").waitFor()
			},
		}),
		settings("repo-rules-escape", "a repository's rules dialog dismissed", {
			steps: async (page) => {
				await page.getByRole("button", { name: "Configure" }).first().click()
				await page.getByRole("dialog").getByText("Repository rules").waitFor()
				await page.keyboard.press("Escape")
			},
		}),
		reposLab("search", "searched", (page) =>
			page.getByRole("textbox", { name: "Search repositories" }).fill("sdk"),
		),
		reposLab("reviewed", "reviewed only", (page) =>
			page
				.getByRole("group", { name: "Review status" })
				.getByRole("button", { name: /^Reviewed/ })
				.click(),
		),
		reposLab("no-match", "a search with no match, then everything shown", async (page) => {
			await page.getByRole("textbox", { name: "Search repositories" }).fill("nothing-matches")
			await page.getByRole("button", { name: "Show all repositories" }).click()
		}),
		issues("loading", "loading (findings held)", held("codeReview.listFindings")),
		issues("error", "findings failing", failing("codeReview.listFindings", "Failed to load issues")),
		issues("repository", "filtered to one repository", {
			steps: (page) => pick(page, "Repository", "acme-shop/payments"),
		}),
		issues("author", "filtered to one author", { steps: (page) => pick(page, "Author", "linus-t") }),
		issues("category", "filtered to one category", {
			steps: (page) => pick(page, "Category", "Observability"),
		}),
		issues("state", "filtered to one state", { steps: (page) => pick(page, "State", "Resolved") }),
		issues("clear-filters", "filtered to nothing, then cleared", {
			steps: async (page) => {
				await pick(page, "Severity", "Critical")
				await pick(page, "State", "Dismissed")
				await page.getByRole("button", { name: "Clear filters" }).click()
			},
		}),
		issues("time-tooltip", "a finding's time hovered", {
			steps: async (page) => {
				await page.getByText("2h ago").first().hover()
				await page.getByText(/^Oct 1, 2026, /).waitFor()
			},
		}),
		issues("sheet-close", "review sheet opened, then closed", {
			steps: async (page) => {
				await page.getByRole("button", { name: /Index built without CONCURRENTLY/ }).click()
				await page.getByRole("button", { name: "Close" }).click()
			},
		}),
	],
}
