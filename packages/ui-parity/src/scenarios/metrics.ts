import type { Page } from "playwright"
import { act, clickButton, opsScenarios, OPS } from "./ops-kit.ts"
import type { AreaModule, Scenario } from "./types.ts"

/** Metric detail pages for each seeded metric type: histogram, sum and gauge. */
const metric = opsScenarios("metrics", "Metric")

/** Held far past any capture, so the screenshot is the loading state. */
const HELD_MS = 60_000

const failing = (prefix: string): NonNullable<Scenario["faults"]> => ({
	failures: {
		[prefix]: {
			status: 502,
			body: {
				_tag: "@maple/http/errors/QueryEngineExecutionError",
				message: "ui-parity: injected query-engine failure",
			},
		},
	},
})

/** Loading and error states of `/metrics` and a metric's page. */
const timed = (
	id: string,
	title: string,
	path: string,
	faults: Scenario["faults"],
	settle: Scenario["settle"],
): Scenario => ({
	id: `metrics-${id}`,
	title: `Metrics: ${title}`,
	path,
	dataset: OPS,
	viewports: ["desktop"],
	themes: ["light", "dark"],
	faults,
	settle,
	area: "metrics",
})

const HISTOGRAM = "/metrics/http.server.request.duration"

const pickMetricType = (name: string) => async (page: Page) => {
	await page.getByRole("combobox", { name: "Metric type" }).click()
	await page.getByRole("option", { name }).click()
}

export const metricsArea: AreaModule = {
	area: "metrics",
	scenarios: [
		metric("histogram", "http.server.request.duration", HISTOGRAM),
		metric("histogram-filtered", "Request duration on payment-svc", HISTOGRAM, {
			steps: act(clickButton(/^Filter to service\.name = payment-svc/)),
		}),
		metric("sum", "shop.orders.created", "/metrics/shop.orders.created"),
		metric("gauge", "system.memory.utilization", "/metrics/system.memory.utilization"),
		metric("browse-table", "the explorer as a table", "/metrics?view=table"),
		metric("browse-gauges", "the explorer filtered to gauges", "/metrics?type=gauge"),
		metric("browse-search", "the explorer searching for cpu", "/metrics?q=cpu"),
		metric("browse-view-toggle", "the explorer switched to the table", "/metrics", {
			steps: act(clickButton("Table view")),
		}),
		metric("browse-type-select", "the explorer narrowed to sums from the type menu", "/metrics", {
			steps: act(pickMetricType("Sum")),
		}),
		metric("browse-open-card", "a preview card opened", "/metrics", {
			steps: act(clickButton(/^system\.memory\.utilization/)),
		}),
		metric("add-dialog", "the Add to dashboard dialog open", HISTOGRAM, {
			steps: act(clickButton("Add to dashboard"), (page) => page.getByRole("dialog").waitFor()),
		}),
		metric("add-existing", "the query added to an existing dashboard", HISTOGRAM, {
			steps: act(
				clickButton("Add to dashboard"),
				clickButton(/^Checkout health/),
				(page) => page.waitForURL(/\/dashboards\//),
			),
		}),
		metric("add-create", "the query added to a new dashboard", HISTOGRAM, {
			steps: act(
				clickButton("Add to dashboard"),
				(page) => page.getByRole("dialog").getByRole("textbox").fill("Request latency"),
				clickButton("Create & add"),
				// The fixture never syncs the create's txid back, so both apps hold on "creating".
				(page) => page.waitForTimeout(500),
			),
		}),
		metric(
			"histogram-grouped",
			"Request duration grouped by service",
			`${HISTOGRAM}?groupBy=service.name`,
		),
		timed(
			"browse-loading",
			"explorer loading (catalog held)",
			"/metrics",
			{ delays: { "queryEngine.listMetrics": HELD_MS } },
			"held",
		),
		timed(
			"browse-error",
			"explorer catalog failing",
			"/metrics",
			failing("queryEngine.listMetrics"),
			"quiet",
		),
		timed(
			"detail-loading",
			"metric loading (catalog held)",
			HISTOGRAM,
			{ delays: { "queryEngine.listMetrics": HELD_MS } },
			"held",
		),
		timed(
			"detail-charts-loading",
			"metric with its chart and breakdown loading (execute-batch held)",
			HISTOGRAM,
			{ delays: { "queryEngine.executeBatch": HELD_MS } },
			"held",
		),
		timed(
			"detail-error",
			"metric catalog failing",
			HISTOGRAM,
			failing("queryEngine.listMetrics"),
			"quiet",
		),
		timed(
			"detail-charts-error",
			"metric with its chart and breakdown failing",
			HISTOGRAM,
			failing("queryEngine.executeBatch"),
			"quiet",
		),
	],
}
