import type { Page } from "playwright"
import { act, clickButton, clickTab, EMPTY, opsScenarios, SEEDED } from "./ops-kit.ts"
import type { AreaModule } from "./types.ts"

/** AI investigations: one running, one diagnosed (payment-svc pool exhaustion), one resolved. */
const investigation = opsScenarios("investigations", "Investigations")
const diagnosed = `/investigations/${SEEDED.diagnosedInvestigation}`

const pickOption = (trigger: string, option: string) => async (page: Page) => {
	await page.getByRole("combobox").filter({ hasText: trigger }).click()
	await page.getByRole("option", { name: option }).click()
}
const waitForText = (text: string | RegExp) => (page: Page) => page.getByText(text).first().waitFor({ state: "visible" })

const menuItem = (name: string) => (page: Page) => page.getByRole("menuitem", { name }).click()
const openSheet = (page: Page) => page.getByRole("dialog").waitFor({ state: "visible" })

/** The running page a create lands on: its live graph re-lays out, so it is masked as in `running`. */
const runningGraph = (page: Page) => [page.getByRole("application", { name: "Investigation provenance graph" })]
const landedOnRunning = (page: Page) => page.waitForURL(new RegExp(`/investigations/${SEEDED.runningInvestigation}`))

const held = { faults: { delays: { "investigations.list": 60_000 } }, settle: "held" as const }
const failing = {
	faults: {
		failures: {
			"investigations.list": {
				status: 500,
				body: { _tag: "@maple/http/investigations/InvestigationPersistenceError", message: "ui-parity: injected investigations failure" },
			},
		},
	},
}

export const investigationsArea: AreaModule = {
	area: "investigations",
	scenarios: [
		investigation("list", "Active investigations", "/investigations"),
		investigation("list-history", "History tab", "/investigations", { steps: act(clickTab(/^History/)) }),
		investigation("diagnosed", "Diagnosed: payment-svc latency", diagnosed),
		investigation("diagnosed-evidence", "Diagnosed, evidence tab", diagnosed, {
			steps: act(clickTab(/^Evidence/)),
		}),
		investigation("diagnosed-menu", "Overflow menu open", diagnosed, {
			steps: act(clickButton("More investigation actions"), (page) => page.getByRole("menu").waitFor({ state: "visible" })),
		}),
		investigation("diagnosed-resolve", "Resolved from the header", diagnosed, {
			steps: act(clickButton(/^Resolve$/), waitForText("Investigation resolved")),
		}),
		investigation("diagnosed-run-again", "Run again from the menu", diagnosed, {
			steps: act(clickButton("More investigation actions"), menuItem("Run again"), waitForText("Investigation restarted")),
		}),
		investigation("diagnosed-mark-resolved", "Mark resolved from the menu", diagnosed, {
			steps: act(clickButton("More investigation actions"), menuItem("Mark resolved"), waitForText("Investigation resolved")),
		}),
		investigation("diagnosed-action", "Proposed action opened from the canvas", diagnosed, {
			steps: act(clickButton(/^Proposed action 01/), openSheet),
		}),
		investigation("diagnosed-action-link", "Proposed action linked by ?action=", `${diagnosed}?action=1`, { steps: act(openSheet) }),
		investigation("diagnosed-action-closed", "Proposed action closed", diagnosed, {
			steps: act(
				clickButton(/^Proposed action 01/),
				openSheet,
				(page) => page.keyboard.press("Escape"),
				(page) => page.getByRole("dialog").waitFor({ state: "hidden" }),
			),
		}),
		investigation("diagnosed-zoom-in", "Canvas zoomed in", diagnosed, { steps: act(clickButton("Zoom in")) }),
		investigation("diagnosed-zoom-out", "Canvas zoomed out", diagnosed, { steps: act(clickButton("Zoom out")) }),
		investigation("diagnosed-fit", "Canvas zoomed, then fitted", diagnosed, {
			steps: act(clickButton("Zoom in"), clickButton("Zoom in"), clickButton("Fit the graph to the view")),
		}),
		investigation("diagnosed-view-service", "Node link to the service", diagnosed, {
			steps: act(
				(page) => page.getByRole("link", { name: "VIEW SERVICE →" }).click(),
				(page) => page.waitForURL(/\/services\/payment-svc/),
			),
		}),
		// The in-progress graph re-lays out as live progress lands (a 1px drift run to run), so it is masked.
		investigation("running", "Still investigating", `/investigations/${SEEDED.runningInvestigation}`, {
			mask: (page) => [page.getByRole("application", { name: "Investigation provenance graph" })],
		}),
		investigation("list-empty", "Investigations (empty org)", "/investigations", { dataset: EMPTY }),
		investigation("list-loading", "List held", "/investigations", held),
		investigation("list-error", "List failing", "/investigations", failing),
		investigation("list-kind-open", "Kind filter open", "/investigations", {
			steps: act((page) => page.getByRole("combobox").filter({ hasText: "All kinds" }).click()),
		}),
		investigation("list-kind-alerts", "Filtered to alerts", "/investigations", { steps: act(pickOption("All kinds", "Alerts")) }),
		investigation("list-sort-severity", "Sorted most severe", "/investigations", {
			steps: act(pickOption("Newest first", "Most severe")),
		}),
		investigation("list-search", "Searched for pool", "/investigations", {
			steps: act((page) => page.getByPlaceholder("Search subjects and findings").fill("pool"), waitForText(/^1 investigation$/)),
		}),
		investigation("list-search-empty", "Search with no match", "/investigations", {
			steps: act((page) => page.getByPlaceholder("Search subjects and findings").fill("zzz"), waitForText(/^No investigations match/)),
		}),
		investigation("list-create", "Investigate bar submitted, lands on the run", "/investigations", {
			steps: act(
				(page) => page.getByRole("textbox", { name: "What should Maple investigate?" }).fill("Why is checkout slow?"),
				(page) => page.getByRole("button", { name: "Investigate", exact: true }).click(),
				landedOnRunning,
				waitForText("Maple is gathering evidence."),
			),
			mask: runningGraph,
		}),
		investigation("list-hero-suggestion", "First-run suggestion started", "/investigations", {
			dataset: EMPTY,
			steps: act(
				(page) => page.getByRole("button", { name: /Which service is slowest right now/ }).click(),
				(page) => page.waitForURL(/\/investigations\/[0-9a-f-]{36}/),
				waitForText(/This investigation is unavailable|Maple is gathering evidence\./),
			),
			mask: runningGraph,
		}),
		investigation("list-typed", "Investigate bar typed", "/investigations", {
			steps: act((page) => page.getByRole("textbox", { name: "What should Maple investigate?" }).fill("Why is checkout slow?")),
		}),
	],
}
