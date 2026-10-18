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

export const widgetTypeScenarios: ReadonlyArray<Scenario> = [
	dashboard("widget-stat", "Widget editor: a stat", editorOf("traces-stat")),
	dashboard("widget-stat-sparkline", "Widget editor: a stat's sparkline turned on, then Apply", editorOf("traces-stat"), {
		steps: act((page) => page.getByText("Show sparkline").click(), clickButton("Apply")),
	}),
	dashboard("widget-gauge", "Widget editor: a gauge", editorOf("traces-gauge")),
	dashboard("widget-gauge-range", "Widget editor: a gauge's max typed, then Apply", editorOf("traces-gauge"), {
		steps: act(fillNumber("100", "5000"), clickButton("Apply")),
	}),
	dashboard("widget-pie", "Widget editor: a pie", editorOf("traces-pie")),
	dashboard("widget-hbar", "Widget editor: a horizontal bar", editorOf("spans-hbar")),
	dashboard("widget-histogram", "Widget editor: a histogram", editorOf("spans-histogram")),
	dashboard("widget-heatmap", "Widget editor: a heatmap", editorOf("errors-heatmap")),
	dashboard("widget-heatmap-log", "Widget editor: a heatmap on a log scale, then Apply", editorOf("errors-heatmap"), {
		steps: act(clickButton("Log"), clickButton("Apply")),
	}),
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
	dashboard("widget-metric", "Widget editor: a metrics query and its metric picker", editorOf("cpu-line")),
	// The list opens near the fold: legacy keeps the side it flipped to before the capture grows the
	// viewport, foldkit re-places it below, so these two differ in the popup's position only.
	dashboard("widget-metric-open", "Widget editor: the metric list open", editorOf("cpu-line"), {
		steps: act((page) => page.getByPlaceholder("Search metrics...").click()),
	}),
	dashboard("widget-metric-search", "Widget editor: the metric list searched", editorOf("cpu-line"), {
		steps: act((page) => page.getByPlaceholder("Search metrics...").fill("http")),
	}),
	dashboard("widget-metric-picked", "Widget editor: another metric picked, then Run preview", editorOf("cpu-line"), {
		steps: act(
			(page) => page.getByPlaceholder("Search metrics...").fill("http"),
			(page) => page.getByRole("option").first().click(),
			clickButton("Run preview"),
		),
	}),
	dashboard("widget-to-stat", "Widget editor: a chart switched to a stat, then Apply", throughput, {
		steps: act(clickButton("Stat"), clickButton("Apply")),
	}),
]
