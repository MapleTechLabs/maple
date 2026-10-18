import type { Locator, Page } from "playwright"
import { clickButton, EMPTY, opsScenarios, SEEDED, act } from "./ops-kit.ts"
import type { AreaModule, Scenario } from "./types.ts"
import { groupedScenarios } from "./dashboards-sections.ts"
import { variableScenarios } from "./dashboards-variables.ts"
import { historyScenarios } from "./dashboards-history.ts"

/**
 * Dashboards built from the API's templates: stat, table, chart and list widgets, the builder in
 * edit mode, one widget's editor, and the template gallery.
 */
const dashboard = opsScenarios("dashboards", "Dashboards")
const platform = `/dashboards/${SEEDED.platformDashboard}`
const gallery = `/dashboards/${SEEDED.widgetsDashboard}`

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

const widgetEditor = `${platform}/widgets/throughput-by-service`

/**
 * A pointer drag in small steps, so the grid resolves cells between moves (legacy steps once per
 * animation frame). `release: false` presses Escape instead of letting go.
 */
const dragBy =
	(handle: (page: Page) => Locator, dx: number, dy: number, release = true) =>
	async (page: Page) => {
		const box = await handle(page).boundingBox()
		if (box === null) return
		const x = box.x + box.width / 2
		const y = box.y + box.height / 2
		await page.mouse.move(x, y)
		await page.mouse.down()
		for (const step of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
			await page.mouse.move(x + (dx * step) / 10, y + (dy * step) / 10)
			await page.waitForTimeout(40)
		}
		if (release) await page.mouse.up()
		else await page.keyboard.press("Escape")
		await page.waitForTimeout(300)
	}

const grip = (name: string) => (page: Page) => page.getByRole("button", { name: `Move ${name}` })

const resizeCorner = (widgetId: string) => (page: Page) =>
	page.locator(`[data-grid-item="${widgetId}"] > [data-grid-resize-handle]`)

/** Focus a tile's grip, then press keys on it with a beat between (each re-renders the grid). */
const pressOnGrip = (name: string, keys: ReadonlyArray<string>) => async (page: Page) => {
	await grip(name)(page).focus()
	for (const key of keys) {
		await page.keyboard.press(key)
		await page.waitForTimeout(80)
	}
	await page.waitForTimeout(300)
}

const pickerTab = (name: string) => (page: Page) => page.getByRole("tab", { name }).click()

const hoverTile = (widgetId: string) => (page: Page) => page.locator(`[data-grid-item="${widgetId}"]`).hover()

const renameWidget = (name: string) => async (page: Page) => {
	await page.getByRole("textbox", { name: "Name" }).fill(name)
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
		dashboard("view-refresh-30s", "Platform overview: auto-refresh every 30s for this viewer", platform, {
			steps: act(clickButton("Auto-refresh off"), clickMenuRadio("30s")),
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
		dashboard("edit-refresh-30s", "Edit mode: 30s saved as the board's auto-refresh", platform, {
			steps: act(enterEdit, clickButton("Auto-refresh off"), clickMenuRadio("30s")),
		}),
		dashboard("edit-dragged", "Edit mode: Total Traces dragged two columns right", platform, {
			steps: act(enterEdit, dragBy(grip("Total Traces"), 300, 0)),
			fullPage: true,
		}),
		dashboard("edit-drag-cancelled", "Edit mode: a drag cancelled with Escape", platform, {
			steps: act(enterEdit, dragBy(grip("Total Traces"), 300, 0, false)),
			fullPage: true,
		}),
		// The Total Traces tile, near the top: a corner near the viewport edge auto-scrolls the board
		// per animation frame, which makes the final size depend on frame timing.
		dashboard("edit-resized", "Edit mode: Total Traces resized wider and taller", platform, {
			steps: act(
				enterEdit,
				hoverTile("total-throughput"),
				dragBy(resizeCorner("total-throughput"), 250, 80),
			),
			fullPage: true,
		}),
		dashboard(
			"edit-keyboard-picked",
			"Edit mode: Total Traces picked up and moved with the keyboard",
			platform,
			{
				steps: act(enterEdit, pressOnGrip("Total Traces", [" ", "ArrowRight", "ArrowDown"])),
				fullPage: true,
			},
		),
		dashboard("edit-keyboard-dropped", "Edit mode: a keyboard move dropped with Space", platform, {
			steps: act(enterEdit, pressOnGrip("Total Traces", [" ", "ArrowRight", "Shift+ArrowRight", " "])),
			fullPage: true,
		}),
		dashboard("edit-picker-stats", "Edit mode: the widget picker's Stats tab", platform, {
			steps: act(enterEdit, clickButton("Add widget"), pickerTab("Stats")),
		}),
		dashboard("edit-picker-tables", "Edit mode: the widget picker's Tables tab", platform, {
			steps: act(enterEdit, clickButton("Add widget"), pickerTab("Tables")),
		}),
		dashboard("edit-picker-lists", "Edit mode: the widget picker's Lists tab", platform, {
			steps: act(enterEdit, clickButton("Add widget"), pickerTab("Lists")),
		}),
		dashboard("edit-picker-notes", "Edit mode: the widget picker's Notes tab", platform, {
			steps: act(enterEdit, clickButton("Add widget"), pickerTab("Notes")),
		}),
		...["Horizontal Bars", "Pies", "Histograms", "Heatmaps", "Funnels", "Paths", "Charts", "All"].map((tab) =>
			dashboard(
				`edit-picker-${tab.toLowerCase().replace(" ", "-")}`,
				`Edit mode: the widget picker's ${tab} tab`,
				platform,
				{ steps: act(enterEdit, clickButton("Add widget"), pickerTab(tab)) },
			),
		),
		dashboard("widgets", "Widget gallery: every breakdown widget, a gauge and a stat sparkline", gallery, {
			fullPage: true,
		}),
		timed(
			"widgets-loading",
			"Widget gallery: widget queries held",
			gallery,
			{ delays: { "queryEngine.": HELD_MS } },
			"held",
		),
		dashboard("widgets-edit", "Widget gallery in edit mode", gallery, {
			steps: act(enterEdit),
			fullPage: true,
		}),
		...groupedScenarios,
		...variableScenarios,
		...historyScenarios,
		dashboard("edit-widget-added", "Edit mode: the Total Logs stat added from the picker", platform, {
			steps: act(enterEdit, clickButton("Add widget"), pickerTab("Stats"), clickButton(/Sum of logs/)),
			fullPage: true,
		}),
		dashboard("edit-note-added", "Edit mode: a note added from the picker", platform, {
			steps: act(enterEdit, clickButton("Add widget"), pickerTab("Notes"), clickButton(/^Note/)),
			fullPage: true,
		}),
		dashboard(
			"blank-widget-added",
			"A blank board: a stat added from the empty state",
			"/dashboards/dash_parity_2",
			{
				steps: act(
					clickButton("Add your first widget"),
					pickerTab("Stats"),
					clickButton(/Sum of logs/),
				),
			},
		),
		dashboard("edit-auto-layout", "Edit mode: Auto layout from the more actions menu", platform, {
			steps: act(enterEdit, clickButton("More dashboard actions"), clickMenuItem("Auto layout")),
			fullPage: true,
		}),
		dashboard("edit-tags-dialog", "Edit mode: the board's tag editor with a typed tag", platform, {
			steps: act(
				enterEdit,
				clickButton("More dashboard actions"),
				clickMenuItem("Tags"),
				typeTag("slo"),
			),
		}),
		dashboard("edit-tags-saved", "Edit mode: the board's tags saved", platform, {
			steps: act(
				enterEdit,
				clickButton("More dashboard actions"),
				clickMenuItem("Tags"),
				typeTag("slo"),
				clickButton("Save"),
			),
		}),
		dashboard("edit-more-menu", "Edit mode: more actions menu", platform, {
			steps: act(enterEdit, clickButton("More dashboard actions")),
		}),
		dashboard("edit-done", "Edit mode left with Done", platform, {
			steps: act(enterEdit, clickButton("Done editing")),
		}),
		dashboard("widget", "Throughput chart widget editor", widgetEditor),
		dashboard("widget-renamed", "Widget editor: renamed, then Apply", widgetEditor, {
			steps: act(renameWidget("Throughput (all services)"), clickButton("Apply")),
		}),
		dashboard("widget-unsaved", "Widget editor: Cancel with unsaved changes", widgetEditor, {
			steps: act(renameWidget("Throughput (all services)"), clickButton("Cancel")),
		}),
		dashboard("widget-discarded", "Widget editor: unsaved changes discarded", widgetEditor, {
			steps: act(
				renameWidget("Throughput (all services)"),
				clickButton("Cancel"),
				clickButton("Discard changes"),
			),
		}),
		dashboard("widget-cancel", "Widget editor: Cancel with nothing changed", widgetEditor, {
			steps: act(clickButton("Cancel")),
		}),
		dashboard("widget-note", "Widget editor: switched to a note with a body typed", widgetEditor, {
			steps: act(clickButton("Note"), async (page) => {
				await page
					.getByPlaceholder(/Runbook/)
					.fill("## Runbook\n- Check **errors** first\n- See [docs](https://maple.dev)")
			}),
		}),
		dashboard("widget-line", "Widget editor: switched to a line chart", widgetEditor, {
			steps: act(clickButton("Line")),
		}),
		dashboard("widget-stats", "Widget editor: the legend's Min/Max/Mean/Last stats", widgetEditor, {
			steps: act(async (page) => {
				await page.getByText("Show Min/Max/Mean/Last stats").click()
			}),
		}),
		// Legacy's live switch leaves the plot anchor's inline transform and width on the new legend
		// column (React reuses the node), so the preview card is masked: the rail and calls still count.
		dashboard("widget-legend-right", "Widget editor: the legend moved to the right", widgetEditor, {
			steps: act(clickButton("Right")),
			mask: (page) => [page.locator("[data-slot=card]").first()],
		}),
		dashboard("widget-ungrouped", "Widget editor: group-by off, preview rerun", widgetEditor, {
			steps: act(clickButton("Group by"), clickButton("Run preview")),
		}),
		dashboard("widget-collapsed", "Widget editor: the query collapsed", widgetEditor, {
			steps: act(clickButton("Collapse query")),
		}),
		// The aggregation select, opened after the editor's first focus (which activates the lazy
		// autocomplete lookups). Legacy's "Query source" select closes the moment it opens, so it has
		// no open-state scenario.
		dashboard("widget-aggregation-menu", "Widget editor: the aggregation select open", widgetEditor, {
			steps: act(clickButton("Collapse query"), clickButton("Expand query"), (page) =>
				page.getByRole("combobox").filter({ hasText: "count" }).first().click(),
			),
		}),
		dashboard("widget-added-query", "Widget editor: a second query added", widgetEditor, {
			steps: act(clickButton("+ Query")),
		}),
		dashboard("widget-added-formula", "Widget editor: a formula added", widgetEditor, {
			steps: act(clickButton("+ Formula")),
		}),
		dashboard("widget-time-1h", "Widget editor: Last 1 hour picked", widgetEditor, {
			steps: act(clickButton("Last 6 hours"), clickButton("Last 1 hour")),
		}),
		dashboard(
			"widget-missing",
			"Widget editor: a widget id that does not exist",
			`${platform}/widgets/nope`,
		),
		timed(
			"widget-loading",
			"Widget editor: the preview's query held",
			widgetEditor,
			{ delays: { "warehouse:": HELD_MS, "queryEngine.": HELD_MS } },
			"held",
		),
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
