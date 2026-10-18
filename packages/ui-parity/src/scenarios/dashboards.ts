import type { Page } from "playwright"
import { clickButton, EMPTY, opsScenarios, SEEDED, act } from "./ops-kit.ts"
import type { AreaModule, Scenario } from "./types.ts"

/**
 * Dashboards built from the API's templates: stat, table, chart and list widgets, the builder in
 * edit mode, one widget's editor, and the template gallery.
 */
const dashboard = opsScenarios("dashboards", "Dashboards")
const platform = `/dashboards/${SEEDED.platformDashboard}`

const clickMenuItem = (name: string | RegExp) => (page: Page) =>
	page.getByRole("menuitem", { name }).first().click()
const clickMenuRadio = (name: string | RegExp) => (page: Page) =>
	page.getByRole("menuitemradio", { name }).first().click()

/** A row's kebab menu on the list. */
const rowMenu = (dashboardName: string) => clickButton(`More actions for ${dashboardName}`)

/** Typing into the toolbar search, then the 300 ms debounce that writes `?q=`. */
const searchList = (query: string) => async (page: Page) => {
	await page.getByRole("textbox", { name: "Search dashboards" }).fill(query)
	await page.waitForTimeout(400)
}

/** A portable dashboard file, as Export writes it. */
const PORTABLE_DASHBOARD = JSON.stringify({
	name: "Imported checkout board",
	description: "Checkout latency, from a file.",
	timeRange: { type: "relative", value: "6h" },
	widgets: [],
})

const importFile = async (page: Page) => {
	await page.getByLabel("Import dashboard JSON file").setInputFiles({
		name: "checkout.json",
		mimeType: "application/json",
		buffer: Buffer.from(PORTABLE_DASHBOARD),
	})
	await page.waitForTimeout(300)
}

/** Held far past any capture, so the screenshot is the loading state. */
const HELD_MS = 60_000

/** A timed or failing variant of a dashboards screen (`faults`, `settle`). */
const timed = (
	id: string,
	title: string,
	path: string,
	faults: Scenario["faults"],
	settle: Scenario["settle"],
	steps?: (page: Page) => Promise<void>,
): Scenario => ({
	...dashboard(id, title, path),
	faults,
	settle,
	...(steps === undefined ? undefined : { steps }),
})

const widgetActions = (index: number) => (page: Page) =>
	page.getByRole("button", { name: "Widget actions" }).nth(index).click()

const enterEdit = clickButton("Edit dashboard")

const renameTo = (name: string) => async (page: Page) => {
	await page.getByRole("button", { name: "Platform overview" }).first().click()
	const input = page.getByRole("textbox").first()
	await input.fill(name)
	await input.press("Enter")
}

const typeTag = (tag: string) => async (page: Page) => {
	await page.getByRole("textbox", { name: "Add a tag" }).fill(tag)
	await page.keyboard.press("Enter")
}

export const dashboardsArea: AreaModule = {
	area: "dashboards",
	scenarios: [
		dashboard("list", "List with template-built boards", "/dashboards"),
		dashboard("list-sort-menu", "List: sort menu open", "/dashboards", {
			steps: act(clickButton("Recently updated")),
		}),
		dashboard("list-sorted", "List: sorted by name", "/dashboards", {
			steps: act(clickButton("Recently updated"), clickMenuRadio("Name A–Z")),
		}),
		dashboard("list-search", "List: searched for payment", "/dashboards", {
			steps: act(searchList("payment")),
		}),
		dashboard("list-search-none", "List: a search nothing matches", "/dashboards", {
			steps: act(searchList("zzz-nothing")),
		}),
		dashboard("list-starred", "List: Platform overview starred", "/dashboards", {
			steps: act(clickButton("Star Platform overview")),
		}),
		dashboard("list-favorites-scope", "List: Favorites scope with nothing starred", "/dashboards", {
			steps: act(clickButton("Favorites")),
		}),
		dashboard("list-row-menu", "List: a row's actions menu", "/dashboards", {
			steps: act(rowMenu("Platform overview")),
		}),
		dashboard("list-delete-confirm", "List: delete confirmation", "/dashboards", {
			steps: act(rowMenu("Platform overview"), clickMenuItem("Delete…")),
		}),
		// Legacy's optimistic delete is racy against the fixture's live shape poll (the row is gone
		// in some captures and back in others), so the page body is masked: the call log is the check.
		dashboard("list-deleted", "List: Platform overview deleted", "/dashboards", {
			steps: act(
				rowMenu("Platform overview"),
				clickMenuItem("Delete…"),
				clickButton("Delete for everyone"),
			),
			mask: (page) => [page.getByRole("main")],
		}),
		dashboard("list-duplicate", "List: Platform overview duplicated", "/dashboards", {
			steps: act(rowMenu("Platform overview"), clickMenuItem("Duplicate")),
		}),
		dashboard("list-tags-dialog", "List: tag editor with a typed tag", "/dashboards", {
			steps: act(rowMenu("Platform overview"), clickMenuItem("Edit tags…"), typeTag("slo")),
		}),
		dashboard("list-tags-saved", "List: tags saved", "/dashboards", {
			steps: act(
				rowMenu("Platform overview"),
				clickMenuItem("Edit tags…"),
				typeTag("slo"),
				clickButton("Save"),
			),
		}),
		dashboard("list-create", "List: Create dashboard", "/dashboards", {
			steps: act(clickButton("Create dashboard")),
		}),
		dashboard("list-import", "List: a portable dashboard imported", "/dashboards", {
			steps: act(importFile),
		}),
		dashboard("platform", "Platform overview (stat, table, chart, list)", platform, { fullPage: true }),
		dashboard("payment", "Payment service health", `/dashboards/${SEEDED.paymentDashboard}`),
		dashboard("view-time-picker", "Platform overview: time range picker open", platform, {
			steps: act(clickButton("Last 6 hours")),
		}),
		dashboard("view-time-1h", "Platform overview: Last 1 hour picked and saved", platform, {
			steps: act(clickButton("Last 6 hours"), clickButton("Last 1 hour")),
			fullPage: true,
		}),
		dashboard("view-reload", "Platform overview: reloaded", platform, {
			steps: act(clickButton("Reload")),
			fullPage: true,
		}),
		dashboard("view-refresh-menu", "Platform overview: auto-refresh menu", platform, {
			steps: act(clickButton("Auto-refresh off")),
		}),
		dashboard("view-more-menu", "Platform overview: more actions menu", platform, {
			steps: act(clickButton("More dashboard actions")),
		}),
		dashboard("view-widget-menu", "Platform overview: a chart's actions menu", platform, {
			steps: act(widgetActions(5)),
		}),
		dashboard("view-table-sorted", "Platform overview: service table sorted by throughput", platform, {
			steps: act(clickButton("Throughput")),
		}),
		dashboard("view-renamed", "Platform overview: renamed inline", platform, {
			steps: act(renameTo("Platform overview v2")),
		}),
		dashboard("view-blank", "A dashboard with no widgets", "/dashboards/dash_parity_2"),
		dashboard("view-missing", "A dashboard id that does not exist", "/dashboards/dash_parity_missing"),
		timed(
			"view-loading",
			"Platform overview: widget queries held",
			platform,
			{ delays: { "queryEngine.": HELD_MS } },
			"held",
		),
		dashboard("edit", "Platform overview in edit mode", platform, {
			steps: act(enterEdit),
		}),
		dashboard("edit-widget-menu", "Edit mode: a tile's actions menu", platform, {
			steps: act(enterEdit, widgetActions(0)),
		}),
		dashboard("edit-widget-deleted", "Edit mode: the Total Traces tile deleted", platform, {
			steps: act(enterEdit, widgetActions(0), clickMenuItem("Delete")),
			fullPage: true,
		}),
		dashboard("edit-widget-restored", "Edit mode: a deleted tile restored with Undo", platform, {
			steps: act(enterEdit, widgetActions(0), clickMenuItem("Delete"), clickButton("Undo")),
			fullPage: true,
		}),
		dashboard("edit-more-menu", "Edit mode: more actions menu", platform, {
			steps: act(enterEdit, clickButton("More dashboard actions")),
		}),
		dashboard("edit-done", "Edit mode left with Done", platform, {
			steps: act(enterEdit, clickButton("Done editing")),
		}),
		dashboard("widget", "Throughput chart widget editor", `${platform}/widgets/throughput-by-service`),
		dashboard("templates", "Template gallery", "/dashboards/templates"),
		dashboard("template-preview", "Service Health template preview", "/dashboards/templates", {
			steps: act(clickButton(/^Service Health/)),
		}),
		dashboard("templates-search", "Template gallery: searched for redis", "/dashboards/templates", {
			steps: act(async (page) => {
				await page.getByRole("textbox", { name: "Search templates" }).fill("redis")
				await page.waitForTimeout(400)
			}),
		}),
		dashboard("templates-needs-setup", "Template gallery: Needs setup only", "/dashboards/templates", {
			steps: act(clickButton("Needs setup")),
		}),
		dashboard(
			"templates-ready-empty",
			"Template gallery: Ready filter over a gated search",
			"/dashboards/templates",
			{
				steps: act(async (page) => {
					await page.getByRole("textbox", { name: "Search templates" }).fill("redis")
					await page.waitForTimeout(400)
				}, clickButton("Ready")),
			},
		),
		dashboard("template-gated", "Redis template: a gated template's panel", "/dashboards/templates", {
			steps: act(clickButton(/^Redis Overview/)),
		}),
		dashboard("template-created", "Platform Overview template instantiated", "/dashboards/templates", {
			steps: act(clickButton(/^Platform Overview/), clickButton("Create dashboard")),
		}),
		dashboard("template-blank", "Blank dashboard from the gallery", "/dashboards/templates", {
			steps: act(clickButton(/^Blank dashboard/)),
		}),
		dashboard("list-empty", "Dashboards (empty org)", "/dashboards", { dataset: EMPTY }),
		dashboard("list-empty-create", "Dashboards (empty org): Create blank dashboard", "/dashboards", {
			dataset: EMPTY,
			steps: act(clickButton("Create blank dashboard")),
		}),
	],
}
