import type { Page } from "playwright"
import { act, clickTab, EMPTY, opsScenarios, SEEDED } from "./ops-kit.ts"
import type { AreaModule } from "./types.ts"

/** AI investigations: one running, one diagnosed (payment-svc pool exhaustion), one resolved. */
const investigation = opsScenarios("investigations", "Investigations")
const diagnosed = `/investigations/${SEEDED.diagnosedInvestigation}`

const pickOption = (trigger: string, option: string) => async (page: Page) => {
	await page.getByRole("combobox").filter({ hasText: trigger }).click()
	await page.getByRole("option", { name: option }).click()
}
const waitForText = (text: string | RegExp) => (page: Page) => page.getByText(text).first().waitFor({ state: "visible" })

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
		investigation("list-typed", "Investigate bar typed", "/investigations", {
			steps: act((page) => page.getByRole("textbox", { name: "What should Maple investigate?" }).fill("Why is checkout slow?")),
		}),
	],
}
