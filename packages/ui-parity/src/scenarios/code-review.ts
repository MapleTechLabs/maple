import type { Page } from "playwright"
import type { AreaModule, Scenario } from "./types.ts"

/**
 * Code Review on dataset `code-review` (src/fixtures/areas/code-review.ts): four repositories, ten
 * reviews, twelve findings and three weeks of GitHub Actions runs. `empty` is an org without
 * GitHub, which shows each tab's on-ramp.
 */
const DATASET = "code-review"
const EMPTY = "empty"

const scenario = (
	id: string,
	title: string,
	path: string,
	options: { readonly dataset?: string; readonly steps?: (page: Page) => Promise<void> } = {},
): Scenario => ({
	id: `code-review-${id}`,
	title: `Code review: ${title}`,
	path,
	dataset: options.dataset ?? DATASET,
	viewports: ["desktop"],
	themes: ["light", "dark"],
	steps: options.steps,
	area: "code-review",
})

const pick = async (page: Page, select: string, option: string) => {
	await page.getByRole("combobox", { name: select }).click()
	await page.getByRole("option", { name: option }).click()
}

export const codeReviewArea: AreaModule = {
	area: "code-review",
	scenarios: [
		scenario("analytics", "Analytics", "/code-review"),
		scenario("analytics-empty", "Analytics (no reviews)", "/code-review", { dataset: EMPTY }),
		scenario("analytics-author", "Analytics filtered to one author", "/code-review", {
			steps: (page) => pick(page, "Author", "ada-l"),
		}),
		scenario("pull-requests", "Pull requests", "/code-review/pull-requests"),
		scenario("pull-requests-empty", "Pull requests (no reviews)", "/code-review/pull-requests", { dataset: EMPTY }),
		scenario("pull-requests-detail", "Pull requests: review sheet open", "/code-review/pull-requests", {
			steps: (page) => page.getByRole("button", { name: /Retry payment capture once/ }).first().click(),
		}),
		scenario("pull-requests-failed", "Pull requests filtered to failed", "/code-review/pull-requests", {
			steps: (page) => pick(page, "Status", "Failed"),
		}),
		scenario("ci", "CI", "/code-review/ci"),
		scenario("ci-empty", "CI (no runs)", "/code-review/ci", { dataset: EMPTY }),
		scenario("ci-failed", "CI runs filtered to failures", "/code-review/ci", {
			steps: (page) => pick(page, "Result", "Failed"),
		}),
		scenario("issues", "Issues", "/code-review/issues"),
		scenario("issues-empty", "Issues (no findings)", "/code-review/issues", { dataset: EMPTY }),
		scenario("issues-critical", "Issues filtered to critical", "/code-review/issues", {
			steps: (page) => pick(page, "Severity", "Critical"),
		}),
		scenario("issues-detail", "Issues: finding's review open", "/code-review/issues", {
			steps: (page) => page.getByRole("button", { name: /Index built without CONCURRENTLY/ }).click(),
		}),
		scenario("settings", "Settings", "/code-review/settings"),
		scenario("settings-empty", "Settings (GitHub not connected)", "/code-review/settings", { dataset: EMPTY }),
		scenario("settings-configure", "Settings: repository rules dialog", "/code-review/settings", {
			steps: (page) => page.getByRole("button", { name: "Configure" }).first().click(),
		}),
	],
}
