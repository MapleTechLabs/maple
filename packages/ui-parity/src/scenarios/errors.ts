import type { Locator, Page } from "playwright"
import { EMPTY, OPS, opsScenarios, SEEDED, settlePointer } from "./ops-kit.ts"
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

/** The in-progress issue, claimed by the dataset's user (a held lease). */
const LEASED_PATH = "/errors/issues/0199a004-0000-7000-8000-000000000002"

/** Picks `option` from the rail select whose trigger reads `current`, then waits for `toast`. */
const pickInRail =
	(trigger: (page: Page) => Locator, option: string, toast?: string) => async (page: Page) => {
		await trigger(page).click()
		await page.getByRole("option", { name: option }).click()
		if (toast !== undefined) await page.getByText(toast, { exact: true }).waitFor()
		await settlePointer(page)
	}
const statusTrigger = (page: Page) => page.getByRole("combobox").filter({ hasText: "Triage" })
const severityTrigger = (page: Page) => page.getByRole("combobox", { name: "Severity" })

const clickThen = (name: string, toast: string) => async (page: Page) => {
	await page.getByRole("button", { name, exact: true }).click()
	await page.getByText(toast, { exact: true }).waitFor()
	await settlePointer(page)
}

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
		errors("issue-status", "status moved to Todo", ISSUE_PATH, {
			steps: pickInRail(statusTrigger, "Todo", "Moved to Todo"),
		}),
		errors("issue-severity-clear", "severity cleared", ISSUE_PATH, {
			steps: pickInRail(severityTrigger, "Not set", "Severity cleared"),
		}),
		errors("issue-severity-escalate", "severity raise asks to notify", ISSUE_PATH, {
			steps: async (page) => {
				await pickInRail(severityTrigger, "High")(page)
				await page.getByRole("alertdialog").getByText("Notify escalation destinations?").waitFor()
			},
		}),
		errors("issue-severity-confirm", "severity raise confirmed", ISSUE_PATH, {
			steps: async (page) => {
				await pickInRail(severityTrigger, "High")(page)
				await clickThen("Change severity and notify", "Severity set to high")(page)
			},
		}),
		errors("issue-claim", "claimed", ISSUE_PATH, { steps: clickThen("Claim", "Claimed") }),
		errors("issue-lease", "a held lease", LEASED_PATH, {
			steps: async (page) => {
				await page.getByText("Active lease").waitFor()
			},
		}),
		errors("issue-lease-extend", "lease extended", LEASED_PATH, {
			steps: clickThen("Extend", "Lease extended"),
		}),
		errors("issue-lease-release", "lease released", LEASED_PATH, {
			steps: clickThen("Release", "Released"),
		}),
		errors("issue-occurrences", "Occurrences tab", `${ISSUE_PATH}?tab=occurrences`, {
			steps: async (page) => {
				await page.getByText("Latest occurrences").waitFor()
			},
		}),
		errors("issue-activity", "Activity tab with history", `${LEASED_PATH}?tab=activity`, {
			steps: async (page) => {
				await page.getByText("Verifying fix").waitFor()
			},
		}),
		errors("issue-activity-empty", "Activity tab, nothing yet", `${ISSUE_PATH}?tab=activity`, {
			steps: async (page) => {
				await page.getByText("No activity yet").waitFor()
			},
		}),
		errors("issue-comment", "a comment posted", `${LEASED_PATH}?tab=activity`, {
			steps: async (page) => {
				await page.getByText("Verifying fix").waitFor()
				await page
					.getByPlaceholder("Context, findings, links… markdown supported")
					.fill("Looks fixed")
				await clickThen("Comment", "Comment added")(page)
			},
		}),
		errors("issue-overflow", "overflow menu open", ISSUE_PATH, {
			steps: async (page) => {
				await page.getByRole("button", { name: "More issue actions" }).click()
				await page.getByRole("menuitem", { name: "Copy fingerprint" }).waitFor()
				await settlePointer(page)
			},
		}),
		errors("issue-copy-fingerprint", "fingerprint copied", ISSUE_PATH, {
			steps: async (page) => {
				await page.getByRole("button", { name: "More issue actions" }).click()
				await page.getByRole("menuitem", { name: "Copy fingerprint" }).click()
				await page.getByText("Fingerprint copied", { exact: true }).waitFor()
				await settlePointer(page)
			},
		}),
		errors("issue-attach-open", "attach dialog", ISSUE_PATH, {
			steps: async (page) => {
				await page.getByRole("button", { name: "Attach", exact: true }).click()
				await page.getByRole("dialog").getByText("Attach a pull request").waitFor()
				await settlePointer(page)
			},
		}),
		errors("issue-attach", "a pull request attached", ISSUE_PATH, {
			steps: async (page) => {
				await page.getByRole("button", { name: "Attach", exact: true }).click()
				const picker = page
					.getByRole("dialog")
					.getByPlaceholder("Search by title, number, branch, or paste a link")
				await picker.fill("https://github.com/acme/storefront/pull/491")
				await picker.press("Enter")
				await page.getByText("Pull request attached", { exact: true }).waitFor()
				await settlePointer(page)
			},
		}),
		errors("issue-detach", "a pull request detached", LEASED_PATH, {
			steps: clickThen("Detach acme/storefront#491", "Pull request detached"),
		}),
		errors("issue-investigate", "Investigate opens a new investigation", ISSUE_PATH, {
			steps: async (page) => {
				await page.getByRole("button", { name: "Investigate", exact: true }).click()
				await page.waitForURL(/\/investigations\//)
				await settlePointer(page)
			},
		}),
		errors("issue-not-found", "an unknown issue", "/errors/issues/0199a004-0000-7000-8000-0000000000ff", {
			steps: async (page) => {
				await page.getByText("Issue not found").waitFor()
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
