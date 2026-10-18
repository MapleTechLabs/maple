import type { Page } from "playwright"
import { act, checkBox, clickButton, clickTab, EMPTY, opsScenarios, SEEDED } from "./ops-kit.ts"
import type { AreaModule } from "./types.ts"

/** Anomaly incidents: payment-svc latency and error rate open, a catalog-api dip resolved. */
const anomaly = opsScenarios("anomalies", "Anomalies")

/** A TanStack search value: JSON, URI-encoded. */
const searchParam = (key: string, value: unknown) => `${key}=${encodeURIComponent(JSON.stringify(value))}`
const ALL = `/anomalies?${searchParam("status", "all")}`

/** Hovers a facet row so its Only / Exclude actions take pointer events, then clicks one. */
const facetAction = (row: string, action: string) => async (page: Page) => {
	await page.getByText(row, { exact: true }).first().hover()
	await page.getByRole("button", { name: action }).click()
}

const DETAIL = `/anomalies/${SEEDED.latencyAnomaly}`
const waitForText = (text: string | RegExp) => (page: Page) => page.getByText(text).first().waitFor({ state: "visible" })
const failingTag = (tag: string) => ({
	faults: {
		failures: {
			[tag]: {
				status: 500,
				body: { _tag: "@maple/http/anomalies/AnomalyPersistenceError", message: "ui-parity: injected anomalies failure" },
			},
		},
	},
})
const held = { faults: { delays: { "anomalies.listIncidents": 60_000 } }, settle: "held" as const }
const failing = {
	faults: {
		failures: {
			"anomalies.listIncidents": {
				status: 500,
				body: { _tag: "@maple/http/anomalies/AnomalyPersistenceError", message: "ui-parity: injected anomalies failure" },
			},
		},
	},
}

export const anomaliesArea: AreaModule = {
	area: "anomalies",
	scenarios: [
		anomaly("list", "Open anomalies", "/anomalies"),
		anomaly("list-all", "All anomalies", "/anomalies", { steps: act(clickTab("All")) }),
		anomaly("detail", "payment-svc p95 latency", `/anomalies/${SEEDED.latencyAnomaly}`),
		anomaly("list-empty", "Anomalies (empty org)", "/anomalies", { dataset: EMPTY }),
		anomaly("list-resolved", "Resolved tab", "/anomalies", { steps: act(clickTab("Resolved")) }),
		anomaly("list-loading", "List held", "/anomalies", held),
		anomaly("list-error", "List failing", "/anomalies", failing),
		anomaly("list-pause", "Live chip paused", "/anomalies", { steps: act(clickButton("Live")) }),
		anomaly("list-filter-severity", "Filtered to critical", ALL, { steps: act(checkBox("Critical")) }),
		anomaly("list-filter-only", "Only catalog-api", ALL, {
			steps: act(facetAction("catalog-api", "Show only catalog-api")),
		}),
		anomaly("list-filter-exclude", "Excluding payment-svc", ALL, {
			steps: act(facetAction("payment-svc", "Exclude payment-svc")),
		}),
		anomaly("list-filtered-empty", "Exclusions leave nothing", `/anomalies?${searchParam("excludedServices", ["payment-svc"])}`),
		anomaly("list-clear-exclusions", "Exclusions cleared from the empty state", `/anomalies?${searchParam("excludedServices", ["payment-svc"])}`, {
			steps: act(clickButton("Remove exclusions")),
		}),
		anomaly("list-chip-remove", "A filter chip removed", `${ALL}&${searchParam("severity", ["critical"])}&${searchParam("services", ["payment-svc"])}`, {
			steps: act(clickButton(/^Remove filter: Severity/)),
		}),
		anomaly("list-chips-clear-all", "Filter chips cleared", `${ALL}&${searchParam("severity", ["critical"])}&${searchParam("services", ["payment-svc"])}`, {
			steps: act(clickButton("Clear all")),
		}),
		anomaly("list-group-collapse", "Critical group collapsed", ALL, { steps: act(clickButton(/^Critical/)) }),
		anomaly("detail-loading", "Detail, incident held", DETAIL, {
			faults: { delays: { "anomalies.getIncident": 60_000 } },
			settle: "held",
		}),
		anomaly("detail-error", "Detail, incident failing", DETAIL, failingTag("anomalies.getIncident")),
		anomaly("detail-not-found", "Detail, unknown incident", "/anomalies/0199a060-0000-7000-8000-0000000000ff"),
		anomaly("detail-chart-loading", "Detail, signal series held", DETAIL, {
			faults: { delays: { "anomalies.getIncidentTimeseries": 60_000 } },
			settle: "held",
		}),
		anomaly("detail-chart-error", "Detail, signal series failing", DETAIL, failingTag("anomalies.getIncidentTimeseries")),
		anomaly("detail-resolve-dialog", "Detail, resolve confirmation", DETAIL, {
			steps: act(clickButton(/^Resolve$/)),
		}),
		anomaly("detail-resolve", "Detail, resolved from the dialog", DETAIL, {
			steps: act(clickButton(/^Resolve$/), (page) => page.getByRole("alertdialog").getByRole("button", { name: "Resolve" }).click(), waitForText("Anomaly resolved")),
		}),
		anomaly("detail-investigate", "Detail, investigation opened", DETAIL, {
			steps: act(
				clickButton("Open investigation"),
				(page) => page.waitForURL(/\/investigations\/[0-9a-f-]{36}/),
				waitForText("Maple is gathering evidence."),
			),
			mask: (page) => [page.getByRole("application", { name: "Investigation provenance graph" })],
		}),
		anomaly("detail-link-dialog", "Detail, link issue dialog", DETAIL, {
			steps: act(clickButton("Link issue"), waitForText(/^Scoped to/)),
		}),
		anomaly("detail-link-all-services", "Detail, link dialog across services", DETAIL, {
			steps: act(clickButton("Link issue"), clickButton("Search all services"), waitForText(/^Showing issues across/)),
		}),
		anomaly("detail-link-search", "Detail, link dialog searched with no match", DETAIL, {
			steps: act(
				clickButton("Link issue"),
				waitForText(/^Scoped to/),
				(page) => page.getByRole("combobox").fill("zzz"),
				waitForText(/^No issues matching/),
			),
		}),
		anomaly("detail-link-select", "Detail, an issue linked", DETAIL, {
			steps: act(
				clickButton("Link issue"),
				(page) => page.getByRole("option").first().click(),
				waitForText("Linked to issue"),
			),
		}),
		anomaly("list-row-hover", "A row hovered", ALL, {
			steps: async (page) => {
				await page.getByText("Throughput", { exact: true }).last().hover()
			},
		}),
	],
}
