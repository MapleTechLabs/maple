import type { Page } from "playwright"
import { act, clickButton, opsScenarios, SEEDED } from "./ops-kit.ts"
import type { Scenario } from "./types.ts"

/**
 * The widget editor on every query-builder panel type of the gallery board: each type's settings
 * rail, and an Apply per type that writes its own display keys.
 */
const dashboard = opsScenarios("dashboards", "Dashboards")
const editorOf = (widgetId: string) => `/dashboards/${SEEDED.widgetsDashboard}/widgets/${widgetId}`
const throughput = `/dashboards/${SEEDED.platformDashboard}/widgets/throughput-by-service`

const fillNumber = (name: string, value: string) => async (page: Page) => {
	const field = page.getByPlaceholder(name, { exact: true })
	await field.fill(value)
}

/** Types into a labelled field, then moves on so a suggestion list it opened closes. */
const fillText = (label: string, value: string) => async (page: Page) => {
	await page.getByRole("combobox", { name: label }).fill(value)
	await page.keyboard.press("Escape")
}

const pickOption = (label: string, option: string) => async (page: Page) => {
	await page.getByRole("combobox", { name: label }).first().click()
	await page.getByRole("option", { name: option, exact: true }).click()
}

/**
 * The paths panel and the funnel's product-event step editor crash legacy-head on render (Base UI
 * error #28, a Field part outside its root), so they cannot be compared; Foldkit captures them alone.
 */
const foldkitOnly = (scenario: Scenario): Scenario => ({ ...scenario, targets: ["foldkit"] })

/** Focus the first query's where clause and type into it, until the suggestion list opens. */
const typeWhere = (text: string): ReadonlyArray<(page: Page) => Promise<void>> => [
	(page) =>
		page
			.getByRole("textbox", { name: /^Where clause for query/ })
			.first()
			.click(),
	(page) => page.keyboard.type(text),
	(page) => page.getByRole("listbox", { name: "Where clause suggestions" }).waitFor(),
]

/** The attribute keys answered, so Enter applies a key rather than the bare `attr.` prefix. */
const keysListed = (page: Page) =>
	page
		.getByRole("option", { name: /^attr\.[a-z]/ })
		.first()
		.waitFor()

export const widgetTypeScenarios: ReadonlyArray<Scenario> = [
	dashboard("widget-stat", "Widget editor: a stat", editorOf("traces-stat")),
	dashboard(
		"widget-stat-sparkline",
		"Widget editor: a stat's sparkline turned on, then Apply",
		editorOf("traces-stat"),
		{
			steps: act((page) => page.getByText("Show sparkline").click(), clickButton("Apply")),
		},
	),
	dashboard("widget-gauge", "Widget editor: a gauge", editorOf("traces-gauge")),
	dashboard(
		"widget-gauge-range",
		"Widget editor: a gauge's max typed, then Apply",
		editorOf("traces-gauge"),
		{
			steps: act(fillNumber("100", "5000"), clickButton("Apply")),
		},
	),
	dashboard("widget-pie", "Widget editor: a pie", editorOf("traces-pie")),
	dashboard("widget-hbar", "Widget editor: a horizontal bar", editorOf("spans-hbar")),
	dashboard("widget-histogram", "Widget editor: a histogram", editorOf("spans-histogram")),
	dashboard("widget-heatmap", "Widget editor: a heatmap", editorOf("errors-heatmap")),
	dashboard(
		"widget-heatmap-log",
		"Widget editor: a heatmap on a log scale, then Apply",
		editorOf("errors-heatmap"),
		{
			steps: act(clickButton("Log"), clickButton("Apply")),
		},
	),
	dashboard("widget-to-table", "Widget editor: a chart switched to a table with a row limit", throughput, {
		steps: act(clickButton("Table"), fillNumber("50", "20"), clickButton("Run preview")),
	}),
	dashboard("widget-sql", "Widget editor: the Raw SQL source with its template", throughput, {
		steps: act((page) => page.getByRole("tab", { name: "Raw SQL" }).click()),
	}),
	dashboard("widget-sql-applied", "Widget editor: Raw SQL run, then Apply", throughput, {
		steps: act(
			(page) => page.getByRole("tab", { name: "Raw SQL" }).click(),
			clickButton("Run preview"),
			clickButton("Apply"),
		),
	}),
	dashboard("widget-sql-collapsed", "Widget editor: the SQL panel collapsed", throughput, {
		steps: act((page) => page.getByRole("tab", { name: "Raw SQL" }).click(), clickButton("Collapse SQL")),
	}),
	// The first viewport only: growing it scrolls the chip out from under the pointer, which closes
	// the tooltip (legacy's stays mounted in its frozen exit animation instead).
	dashboard("widget-sql-chip-tooltip", "Widget editor: a Raw SQL macro chip's description", throughput, {
		fullPage: false,
		steps: async (page) => {
			await page.getByRole("tab", { name: "Raw SQL" }).click()
			await page.getByRole("button", { name: "$__orgFilter", exact: true }).hover()
			await page.getByText("Required: expands to OrgId = '<your org>'").waitFor()
		},
	}),
	dashboard("widget-metric", "Widget editor: a metrics query and its metric picker", editorOf("cpu-line")),
	// The list opens near the fold and flips above; the capture then grows the viewport, and the
	// combobox keeps the flipped side (Base UI's `lazyFlip`).
	dashboard("widget-metric-open", "Widget editor: the metric list open", editorOf("cpu-line"), {
		steps: act((page) => page.getByPlaceholder("Search metrics...").click()),
	}),
	dashboard("widget-metric-search", "Widget editor: the metric list searched", editorOf("cpu-line"), {
		steps: act((page) => page.getByPlaceholder("Search metrics...").fill("http")),
	}),
	dashboard(
		"widget-metric-picked",
		"Widget editor: another metric picked, then Run preview",
		editorOf("cpu-line"),
		{
			steps: act(
				(page) => page.getByPlaceholder("Search metrics...").fill("http"),
				(page) => page.getByRole("option").first().click(),
				clickButton("Run preview"),
			),
		},
	),
	dashboard("widget-to-stat", "Widget editor: a chart switched to a stat, then Apply", throughput, {
		steps: act(clickButton("Stat"), clickButton("Apply")),
	}),
	dashboard("widget-to-list", "Widget editor: a chart switched to a list, its config panel", throughput, {
		steps: act(clickButton("List")),
	}),
	dashboard(
		"widget-list-logs",
		"Widget editor: a list on logs with a column added, then Apply",
		throughput,
		{
			steps: act(
				clickButton("List"),
				clickButton("Logs"),
				clickButton("+ Column"),
				(page) => page.getByPlaceholder("Header", { exact: true }).nth(4).fill("Trace"),
				clickButton("Apply"),
			),
		},
	),
	foldkitOnly(
		dashboard(
			"widget-to-paths",
			"Widget editor: a chart switched to paths, its anchor panel",
			throughput,
			{
				steps: act(clickButton("Paths")),
			},
		),
	),
	foldkitOnly(
		dashboard(
			"widget-paths-applied",
			"Widget editor: paths anchored on an event, looking back four steps, then Apply",
			throughput,
			{
				steps: act(
					clickButton("Paths"),
					fillText("Step 1 event name", "checkout_started"),
					clickButton("Before"),
					(page) => page.getByRole("button", { name: "4", exact: true }).first().click(),
					clickButton("Apply"),
				),
			},
		),
	),
	dashboard(
		"widget-funnel",
		"Widget editor: a query-set funnel and its view settings",
		editorOf("traces-funnel"),
	),
	dashboard(
		"widget-funnel-dropoff",
		"Widget editor: a funnel switched to drop-off, then Apply",
		editorOf("traces-funnel"),
		{
			steps: act(clickButton("Drop-off"), clickButton("Conversion"), clickButton("Apply")),
		},
	),
	foldkitOnly(
		dashboard(
			"widget-funnel-steps",
			"Widget editor: a funnel on product events, two steps",
			editorOf("traces-funnel"),
			{
				steps: act(
					pickOption("Query source", "Product events"),
					fillText("Step 1 event name", "product_viewed"),
					clickButton("Add step"),
					fillText("Step 2 event name", "checkout_started"),
					clickButton("Window"),
				),
			},
		),
	),
	foldkitOnly(
		dashboard(
			"widget-funnel-steps-applied",
			"Widget editor: a product-event funnel, then Apply",
			editorOf("traces-funnel"),
			{
				steps: act(
					pickOption("Query source", "Product events"),
					fillText("Step 1 event name", "product_viewed"),
					clickButton("Add step"),
					fillText("Step 2 event name", "checkout_started"),
					clickButton("Apply"),
				),
			},
		),
	),
	dashboard("widget-where-values", "Widget editor: the where clause's service suggestions", throughput, {
		steps: act(...typeWhere("service.name = ")),
	}),
	dashboard(
		"widget-where-attr",
		"Widget editor: an attribute key applied with Enter, its values offered",
		throughput,
		{
			steps: act(
				...typeWhere("attr."),
				keysListed,
				(page) => page.keyboard.press("Enter"),
				(page) => page.waitForTimeout(700),
			),
		},
	),
	dashboard(
		"widget-where-picked",
		"Widget editor: a suggestion clicked into the where clause",
		throughput,
		{
			steps: act(...typeWhere("service.name = "), (page) => page.getByRole("option").first().click()),
		},
	),
	// A key typed in full puts the caret in its value: the metric's values for it are asked for.
	dashboard(
		"widget-metric-where",
		"Widget editor: a metric attribute's value suggestions asked for",
		editorOf("cpu-line"),
		{
			steps: act(
				(page) =>
					page
						.getByRole("textbox", { name: /^Where clause for query/ })
						.first()
						.click(),
				(page) => page.keyboard.type("attr.host.name = "),
				(page) => page.waitForTimeout(700),
			),
		},
	),
]
