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

/** An alert-backed issue, served by id only. */
const ALERT_PATH = "/errors/issues/0199a004-0000-7000-8000-000000000050"

/** The in-progress issue, claimed by the dataset's user (a held lease). */
const LEASED_PATH = "/errors/issues/0199a004-0000-7000-8000-000000000002"

/** `default` with a busy worked issue and a GitHub App on two repositories (`fixtures/areas/errors.ts`). */
const ERRORS_BUSY = "errors-busy"

/** Picks `option` from the rail select whose trigger reads `current`, then waits for `toast`. */
const pickInRail =
	(trigger: (page: Page) => Locator, option: string, toast?: string) => async (page: Page) => {
		await trigger(page).click()
		await page.getByRole("option", { name: option }).click()
		if (toast !== undefined) await page.getByText(toast, { exact: true }).waitFor()
		await settlePointer(page)
	}
/** A closed popup uncovers a row under the pointer: both apps focus it on hover; wait for that. */
const rowHoverSettled = (page: Page) =>
	page.waitForFunction(() => {
		const hovered = document.querySelector("[data-issue-id]:hover")
		return hovered === null || hovered.hasAttribute("data-focused")
	})

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
		// `errors-busy`: the worked issue past the timeline's 50 recent rows, and two GitHub repositories.
		errors("issue-activity-capped", "a busy timeline shows its latest 50 rows", `${LEASED_PATH}?tab=activity`, {
			dataset: ERRORS_BUSY,
			steps: async (page) => {
				await page.getByRole("button", { name: /^Show \d+ earlier events$/ }).waitFor()
			},
		}),
		errors("issue-activity-earlier", "Show earlier reveals the rest of a busy timeline", `${LEASED_PATH}?tab=activity`, {
			dataset: ERRORS_BUSY,
			steps: async (page) => {
				await page.getByRole("button", { name: /^Show \d+ earlier events$/ }).click()
				await settlePointer(page)
			},
		}),
		errors("issue-attach-repository", "the attach dialog's repository select, another one picked", ISSUE_PATH, {
			dataset: ERRORS_BUSY,
			steps: async (page) => {
				await page.getByRole("button", { name: "Attach", exact: true }).click()
				await page.getByRole("dialog").getByRole("combobox", { name: "Repository" }).click()
				await page.getByRole("option", { name: "acme-shop/storefront" }).click()
				await page.waitForTimeout(300)
				await settlePointer(page)
			},
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
		errors("issue-alert", "an alert-backed issue", ALERT_PATH, {
			steps: async (page) => {
				await page.getByText("Alert source").waitFor()
			},
		}),
		errors("issue-alert-overflow", "an alert issue's overflow menu", ALERT_PATH, {
			steps: async (page) => {
				await page.getByText("Alert source").waitFor()
				await page.getByRole("button", { name: "More issue actions" }).click()
				await page.getByRole("menuitem", { name: "View alert rule" }).waitFor()
				await settlePointer(page)
			},
		}),
		errors("hub-select-range", "shift-click selects a range", "/errors", {
			steps: async (page) => {
				const boxes = page.getByRole("checkbox", { name: "Select this error" })
				await boxes.nth(0).click()
				await boxes.nth(2).click({ modifiers: ["Shift"] })
				await page.getByText("3 selected").waitFor()
				await settlePointer(page)
			},
		}),
		errors("hub-bulk-claim", "bulk claim", "/errors", {
			steps: async (page) => {
				const boxes = page.getByRole("checkbox", { name: "Select this error" })
				await boxes.nth(0).click()
				await boxes.nth(1).click()
				await page
					.getByRole("region", { name: "Bulk actions" })
					.getByRole("button", { name: "Claim" })
					.click()
				await page.getByText("Claimed 2 issues", { exact: true }).waitFor()
				await settlePointer(page)
			},
		}),
		errors("hub-bulk-severity-menu", "bulk severity menu", "/errors", {
			steps: async (page) => {
				await page.getByRole("checkbox", { name: "Select this error" }).nth(0).click()
				await page
					.getByRole("region", { name: "Bulk actions" })
					.getByRole("button", { name: "Severity" })
					.click()
				await page.getByRole("menuitem", { name: "Clear severity" }).waitFor()
				await settlePointer(page)
			},
		}),
		errors("hub-bulk-move", "bulk move to Todo", "/errors", {
			steps: async (page) => {
				await page.getByRole("checkbox", { name: "Select this error" }).nth(0).click()
				await page
					.getByRole("region", { name: "Bulk actions" })
					.getByRole("button", { name: "Move to" })
					.click()
				await page.getByRole("menuitem", { name: "Todo" }).click()
				await page.getByText("Moved 1 to Todo", { exact: true }).waitFor()
				await settlePointer(page)
			},
		}),
		errors("hub-keyboard", "j, j, x on the list", "/errors", {
			steps: async (page) => {
				await page
					.getByText(/^\d+ issues?$/)
					.first()
					.waitFor()
				await page.keyboard.press("j")
				await page.keyboard.press("j")
				await page.keyboard.press("x")
				await page.getByText("1 selected").waitFor()
				await settlePointer(page)
			},
		}),
		errors("hub-keyboard-open", "j then Enter opens the issue", "/errors", {
			steps: async (page) => {
				await page
					.getByText(/^\d+ issues?$/)
					.first()
					.waitFor()
				await page.keyboard.press("j")
				await page.keyboard.press("Enter")
				await page.waitForURL(/\/errors\/issues\//)
				await page.getByText("Fingerprint").first().waitFor()
				await settlePointer(page)
			},
		}),
		errors("hub-context-menu", "right-click on a row", "/errors", {
			steps: async (page) => {
				await page.getByRole("checkbox", { name: "Select this error" }).nth(0).waitFor()
				await page.locator("[data-issue-id]").first().click({ button: "right" })
				await page.getByRole("menuitem", { name: "Copy link" }).waitFor()
			},
		}),
		errors("hub-context-claim", "claim from the context menu", "/errors", {
			steps: async (page) => {
				await page.getByRole("checkbox", { name: "Select this error" }).nth(0).waitFor()
				await page.locator("[data-issue-id]").first().click({ button: "right" })
				await page.getByRole("menuitem", { name: "Claim" }).click()
				await page.getByText("Claimed", { exact: true }).waitFor()
				await rowHoverSettled(page)
				await settlePointer(page)
			},
		}),
		errors("hub-status-picker", "a row's status picker", "/errors", {
			steps: async (page) => {
				await page.locator("[data-picker=state]").first().click()
				await page.getByRole("option", { name: "Todo" }).waitFor()
				await settlePointer(page)
			},
		}),
		errors("hub-status-pick", "status picked from a row", "/errors", {
			steps: async (page) => {
				await page.locator("[data-picker=state]").first().click()
				await page.getByRole("option", { name: "Todo" }).click()
				await page.getByText("Moved to Todo", { exact: true }).waitFor()
				await rowHoverSettled(page)
				await settlePointer(page)
			},
		}),
		errors("hub-severity-hotkey", "p opens the focused row's severity picker", "/errors", {
			steps: async (page) => {
				await page
					.getByText(/^\d+ issues?$/)
					.first()
					.waitFor()
				await page.keyboard.press("j")
				await page.keyboard.press("p")
				await page.getByRole("option", { name: "No severity" }).waitFor()
				await settlePointer(page)
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
