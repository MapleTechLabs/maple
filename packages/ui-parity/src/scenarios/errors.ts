import { EMPTY, OPS, opsScenarios, SEEDED } from "./ops-kit.ts"
import type { AreaModule, Scenario } from "./types.ts"

/** The error issues list (`/errors/issues`); the hub and one issue live in the routes area. */
const errors = opsScenarios("errors", "Errors")

/** The pool-timeout issue, seeded on every dataset of the `default` org. */
const ISSUE_PATH = `/errors/issues/${SEEDED.triageIssue}`

/** Held far past any capture, so the screenshot is the loading state. */
const HELD_MS = 60_000

/** `/errors` on `acme-ops` with faults on the issues list or the issue detail. */
const timed = (
	id: string,
	title: string,
	path: string,
	faults: Scenario["faults"],
	settle: Scenario["settle"],
): Scenario => ({
	id: `errors-${id}`,
	title: `Errors: ${title}`,
	path,
	dataset: OPS,
	viewports: ["desktop"],
	themes: ["light", "dark"],
	faults,
	settle,
	area: "errors",
})

const listFailure = (tag: string) => ({
	failures: { [tag]: { status: 500, body: { message: "ui-parity: injected failure" } } },
})

export const errorsArea: AreaModule = {
	area: "errors",
	scenarios: [
		errors("issues", "Issues list", "/errors/issues"),
		errors("issues-empty", "Issues list (empty org)", "/errors/issues", { dataset: EMPTY }),
		timed(
			"hub-loading",
			"list loading (issues held)",
			"/errors",
			{ delays: { "errorIssues.list": HELD_MS } },
			"held",
		),
		timed("hub-error", "list failing", "/errors", listFailure("errorIssues.list"), "quiet"),
		timed(
			"issue-loading",
			"issue loading (detail held)",
			ISSUE_PATH,
			{ delays: { "errorIssues.retrieve": HELD_MS } },
			"held",
		),
		timed("issue-error", "issue failing", ISSUE_PATH, listFailure("errorIssues.retrieve"), "quiet"),
		errors("hub-closed", "Closed tab", "/errors", {
			steps: async (page) => {
				await page.getByRole("tab", { name: "Closed" }).click()
				await page
					.getByText(/^(Nothing closed yet|\d+ issues?)$/)
					.first()
					.waitFor()
			},
		}),
		errors("hub-service-filter", "storefront only, from the sidebar", "/errors", {
			steps: async (page) => {
				await page.getByRole("checkbox", { name: "storefront", exact: true }).click()
				await page.getByText("3 issues", { exact: true }).waitFor()
			},
		}),
		// From the URL: the toolbar search debounces on a timer the frozen capture clock never fires.
		errors("hub-search-empty", "a search with no matches", "/errors?q=zzz-no-such-error", {
			steps: async (page) => {
				await page.getByText("Clear search").waitFor()
			},
		}),
		errors("hub-severity-empty", "a severity with no issues", "/errors?severity=low", {
			steps: async (page) => {
				await page.getByText("Show all severities").waitFor()
			},
		}),
		errors("hub-sort-volume", "sorted by volume", "/errors", {
			steps: async (page) => {
				await page.getByRole("combobox").filter({ hasText: "Most recent" }).click()
				await page.getByRole("option", { name: "Most errors" }).click()
				await page.getByRole("combobox").filter({ hasText: "Most errors" }).waitFor()
			},
		}),
	],
}
